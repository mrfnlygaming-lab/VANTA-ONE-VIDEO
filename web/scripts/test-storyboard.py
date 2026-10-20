#!/usr/bin/env python3
"""Real UI/video tests for prompts, ordered images and the extension popup.

Requires Python Playwright, Chromium and FFmpeg/ffprobe. The default uses the
exact standalone HTML at an offline routed origin. --server tests a running app.
Managed browser policy is never changed, and file:// navigation is not claimed.
"""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import zlib
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--server')
parser.add_argument('--evidence-dir', type=Path, default=Path('/tmp/vanta-storyboard-test'))
args = parser.parse_args()
evidence = args.evidence_dir
evidence.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parents[1]


def png(color):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    pixels = (b'\0' + bytes(color) * 160) * 96
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 160, 96, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


images = [dict(name=name + '.png', mimeType='image/png', buffer=png(color)) for name, color in [
    ('red', (255, 0, 0)), ('green', (0, 255, 0)), ('blue', (0, 0, 255)), ('yellow', (255, 255, 0))]]
results = {'mode': 'server' if args.server else 'offline standalone', 'errors': [], 'external_requests': []}


def check_video(filename, duration, samples):
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
        'stream=codec_name,width,height:format=duration', '-of', 'json', str(filename)], text=True))
    assert (probe['streams'][0]['width'], probe['streams'][0]['height']) == (1280, 720), probe
    assert abs(float(probe['format']['duration']) - duration) < 0.9, probe
    colors = []
    for at, channels in samples:
        pixel = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(at), '-i', str(filename),
            '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
        assert len(pixel) == 3, (at, pixel)
        assert all(pixel[c] > 170 if c in channels else pixel[c] < 70 for c in range(3)), (at, list(pixel), channels)
        colors.append(list(pixel))
    return {'duration': probe['format']['duration'], 'codec': probe['streams'][0]['codec_name'], 'sample_colors': colors}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True, offline=not bool(args.server))
    if args.server:
        url = args.server.rstrip('/')
    else:
        url = 'http://localhost:47872/VANTA-OPEN.html'
        html = (root / 'dist/VANTA-OPEN.html').read_text()
        def route(request):
            if request.request.url == url:
                request.fulfill(status=200, content_type='text/html', body=html)
            else:
                results['external_requests'].append(request.request.url)
                request.abort()
        context.route('http://**/*', route)
        context.route('https://**/*', route)
    page = context.new_page()
    page.on('pageerror', lambda error: results['errors'].append(str(error)))
    initial_ids = set()
    try:
        page.goto(url, wait_until='networkidle')
        page.get_by_text('Renderer online' if args.server else 'Browser renderer ready', exact=True).wait_for()
        if args.server:
            initial_ids = {item['id'] for item in page.request.get(url + '/api/videos').json()['videos']}
        page.get_by_label('Add images', exact=True).set_input_files(images[:3])
        page.locator('.storyboard-image').nth(2).wait_for()
        page.get_by_role('button', name='Move image 3 earlier', exact=True).click()
        page.get_by_role('button', name='Move image 2 later', exact=True).click()
        page.get_by_label('Prompt / camera direction', exact=True).fill('Pan right across the scene')
        assert page.locator('#motion').input_value() == 'pan-right'
        page.get_by_role('button', name='3s', exact=True).click()
        page.get_by_role('button', name='Generate video', exact=True).click()

        def completed_popup(seconds):
            dialog = page.get_by_role('dialog', name='Keep the story going?', exact=True)
            dialog.wait_for(timeout=90000)
            assert f'Your {seconds}-second video is saved.' in dialog.inner_text()
            return dialog

        def download(name):
            with page.expect_download() as info:
                page.get_by_role('link', name='Download', exact=True).click()
            item = info.value
            target = evidence / (name + '.' + item.suggested_filename.rsplit('.', 1)[-1])
            item.save_as(str(target))
            assert item.failure() is None and target.stat().st_size > 1000
            return target

        dialog = completed_popup(3)
        results['auto_popup'] = True
        page.keyboard.press('Shift+Tab')
        assert page.evaluate('document.activeElement.textContent').strip() == 'Download current video'
        page.keyboard.press('Escape')
        assert page.get_by_role('dialog').count() == 0
        first = download('three-images')
        results['three_images'] = check_video(first, 3, [(0.5, [0]), (1.5, [1]), (2.5, [2])])
        video = page.get_by_label('Generated video', exact=True)
        video.evaluate('(v)=>v.play()')
        before = video.evaluate('(v)=>v.currentTime')
        page.wait_for_timeout(500)
        assert video.evaluate('(v)=>v.currentTime') > before
        video.evaluate('(v)=>v.pause()')
        page.get_by_role('button', name='Extend video', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('Extension prompt', exact=True).fill('Zoom out slowly')
        dialog.get_by_label('Add extension images', exact=True).set_input_files(images[3:])
        dialog.locator('.storyboard-image').wait_for()
        dialog.get_by_role('button', name='Generate extension', exact=True).click()
        dialog.wait_for(state='hidden')
        dialog = completed_popup(6)
        dialog.get_by_role('button', name='Not now', exact=True).click()
        second = download('extended-images')
        results['extended_images'] = check_video(second, 6, [(0.5, [0]), (1.5, [1]), (2.5, [2]), (4.5, [0, 1])])
        page.get_by_role('button', name='Extend video', exact=True).click()
        page.get_by_label('Extension prompt', exact=True).fill('Keep the camera still')
        page.get_by_role('button', name='Generate extension', exact=True).click()
        page.get_by_role('dialog').wait_for(state='hidden')
        dialog = completed_popup(9)
        dialog.get_by_role('button', name='Not now', exact=True).click()
        third = download('continued-final-frame')
        results['continuation'] = check_video(third, 9, [(0.5, [0]), (1.5, [1]), (2.5, [2]), (4.5, [0, 1]), (7.5, [0, 1])])
        page.reload(wait_until='networkidle')
        page.get_by_role('button', name='My videos').click()
        assert page.locator('article.video-card').count() >= 3
        page.get_by_role('button', name='Extend saved video').first.click()
        page.get_by_role('dialog').wait_for()
        page.keyboard.press('Escape')
        page.get_by_role('button', name='Create video', exact=True).click()
        page.get_by_label('Add images', exact=True).set_input_files(images[:3] * 2)
        page.locator('.storyboard-image').nth(5).wait_for()
        page.get_by_label('Add images', exact=True).set_input_files(images[:1])
        assert 'up to 6 images' in page.get_by_role('alert').inner_text()
        assert page.locator('.storyboard-image').count() == 6
        page.get_by_role('button', name='Dismiss error', exact=True).click()
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth') == 390
        page.get_by_role('button', name='My videos').click()
        page.get_by_role('button', name='Extend saved video').first.click()
        modal = page.get_by_role('dialog')
        assert modal.bounding_box()['height'] <= 810
        modal.get_by_role('button', name='Generate extension', exact=True).scroll_into_view_if_needed()
        assert page.evaluate('document.documentElement.scrollWidth') == 390
        page.screenshot(path=str(evidence / 'mobile-popup.png'), full_page=True)
        page.keyboard.press('Escape')
        assert page.get_by_role('dialog').count() == 0
        results['mobile_popup'] = 'passed'
        assert not results['errors'] and not results['external_requests'], results
        results['passed'] = True
    except Exception as error:
        results['passed'] = False
        results['failure'] = str(error)
        page.screenshot(path=str(evidence / 'failure.png'), full_page=True)
        raise
    finally:
        if args.server:
            for item in page.request.get(url + '/api/videos').json()['videos']:
                if item['id'] not in initial_ids:
                    page.request.delete(url + '/api/videos/' + item['id'])
        (evidence / 'results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))
        browser.close()
