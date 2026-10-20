#!/usr/bin/env python3
"""Check real 1080p storyboards and cumulative extensions in Chromium.

Requires Python Playwright, Chromium, FFmpeg, and ffprobe. By default the exact
standalone HTML is supplied through routing at an offline localhost origin. No
server starts and no browser policy is changed. Pass --url http://localhost:3001
to test the running server instead. Fresh browser storage isolates local tests;
server tests preserve existing videos and delete only videos this run created.
"""
import argparse
import hashlib
import json
import struct
import subprocess
import traceback
import zlib
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--html', type=Path, default=Path(__file__).resolve().parents[1] / 'dist/VANTA-OPEN.html')
parser.add_argument('--url', help='Use a running server instead of offline standalone HTML')
parser.add_argument('--browser', default='/usr/bin/chromium')
parser.add_argument('--evidence-dir', type=Path, default=Path('/tmp/vanta-storyboard-smoke'))
parser.add_argument('--skip-second-extension', action='store_true')
args = parser.parse_args()
evidence = args.evidence_dir.resolve()
evidence.mkdir(parents=True, exist_ok=True)
html = args.html.read_text() if not args.url else None
url = args.url or 'http://localhost:47872/VANTA-OPEN.html'
results = {'mode': 'server' if args.url else 'offline routed standalone HTML (file:// not exercised)', 'page_errors': [], 'console_errors': [], 'unexpected_http_requests': []}
if html:
    results['html_sha256'] = hashlib.sha256(html.encode()).hexdigest()
created = []

def png(color):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    rows = (b'\x00' + bytes(color) * 640) * 360
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 640, 360, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')

def image_file(name, color):
    return {'name': name + '.png', 'mimeType': 'image/png', 'buffer': png(color)}

def read_jobs(page):
    if args.url:
        response = page.request.get(url.rstrip('/') + '/api/videos')
        assert response.ok
        return response.json()['videos']
    return page.evaluate('''() => new Promise((resolve,reject)=>{
      const request=indexedDB.open('vanta-motion-studio',1);
      request.onsuccess=()=>{const db=request.result;const tx=db.transaction('videos');
        const get=tx.objectStore('videos').getAll();get.onsuccess=()=>{resolve(get.result.map(record=>record.job));db.close()};get.onerror=()=>reject(get.error)};
      request.onerror=()=>reject(request.error)
    })''')

def sample_color(path, seconds):
    raw = subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', str(seconds), '-i', str(path), '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-'])
    assert len(raw) == 3, (seconds, raw)
    return list(raw)

def assert_color(actual, expected):
    assert all(abs(a-b) < 45 for a,b in zip(actual, expected)), (actual, expected)

def inspect_video(path, nominal_duration, colors):
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration,size', '-of', 'json', str(path)], text=True))
    stream = probe['streams'][0]
    assert (stream['width'], stream['height']) == (1920, 1080), probe
    assert nominal_duration - 0.2 <= float(probe['format']['duration']) <= nominal_duration + 1.1, probe
    if path.suffix == '.mp4':
        assert stream['codec_name'] == 'h264', probe
    samples = []
    for seconds, expected in colors:
        actual = sample_color(path, seconds)
        assert_color(actual, expected)
        samples.append({'seconds': seconds, 'rgb': actual, 'expected': expected})
    return {'ffprobe': probe, 'samples': samples}

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000}, accept_downloads=True, offline=not bool(args.url))
    if html:
        def intercept(route):
            if route.request.url == url:
                route.fulfill(status=200, content_type='text/html', body=html)
            else:
                results['unexpected_http_requests'].append(route.request.url)
                route.abort()
        context.route('http://**/*', intercept)
        context.route('https://**/*', intercept)
    page = context.new_page()
    page.on('pageerror', lambda error: results['page_errors'].append(str(error)))
    page.on('console', lambda message: results['console_errors'].append(message.text) if message.type == 'error' else None)
    try:
        page.goto(url, wait_until='networkidle')
        page.get_by_text('Renderer online' if args.url else 'Browser renderer ready', exact=True).wait_for()
        initial_ids = [job['id'] for job in read_jobs(page)]
        results['initial_ids'] = initial_ids
        assert page.locator('#generation-engine').input_value() == 'ai'
        if not args.url:
            assert page.get_by_role('button', name='Generate AI scene', exact=True).is_disabled()
            assert 'cannot generate AI scenes' in page.locator('.ai-setup-message').inner_text()
            page.locator('input[aria-label="Add images"]').set_input_files([image_file('reference-red',(255,0,0)),image_file('reference-blue',(0,0,255))])
            page.wait_for_function('document.querySelectorAll(".settings-panel .storyboard-image").length===2')
            page.get_by_label('Full scene prompt', exact=True).fill('Put both subjects into one continuous moving scene.')
            assert page.get_by_role('button', name='Generate AI scene', exact=True).is_disabled()
            results['standalone_ai_guard'] = True
        page.locator('#generation-engine').select_option('camera')
        if not args.url:
            assert page.locator('.settings-panel .storyboard-image').count() == 2
            results['mode_switch_preserves_images'] = True
            page.get_by_role('button', name='Remove image 2', exact=True).click()
            page.get_by_role('button', name='Remove image 1', exact=True).click()
        main_input = page.locator('input[aria-label="Add images"]')
        files = [image_file('blue',(0,0,255)), image_file('red',(255,0,0)), image_file('green',(0,255,0)), image_file('cyan',(0,255,255)), image_file('magenta',(255,0,255)), image_file('white',(255,255,255)), image_file('black',(0,0,0))]
        main_input.set_input_files(files)
        page.get_by_role('alert').wait_for()
        assert 'up to 6 images' in page.get_by_role('alert').inner_text()
        assert page.locator('.settings-panel .storyboard-image').count() == 0
        results['seven_images_rejected'] = page.get_by_role('alert').inner_text()
        page.get_by_role('button', name='Dismiss error', exact=True).click()
        main_input.set_input_files(files[:6])
        page.wait_for_function('document.querySelectorAll(".settings-panel .storyboard-image").length===6')
        results['six_images_accepted'] = True
        for index in [6,5,4]:
            page.get_by_role('button', name=f'Remove image {index}', exact=True).click()
        # B,R,G -> R,B,G -> R,G,B proves both reorder directions affect output.
        page.get_by_role('button', name='Move image 1 later', exact=True).click()
        page.get_by_role('button', name='Move image 3 earlier', exact=True).click()
        page.get_by_label('Prompt / camera direction', exact=True).fill('Pan right')
        page.get_by_role('button', name='3s', exact=True).click()
        page.get_by_role('button', name='Generate video', exact=True).click()

        def completion():
            dialog = page.get_by_role('dialog', name='Keep the story going?', exact=True)
            dialog.wait_for(timeout=120000)
            return dialog

        def download_current(stem, nominal_duration, colors):
            video = page.get_by_label('Generated video', exact=True)
            video.wait_for()
            video.evaluate('(v)=>v.play()')
            before = video.evaluate('(v)=>v.currentTime')
            page.wait_for_timeout(400)
            after = video.evaluate('(v)=>v.currentTime')
            assert after > before, (before, after)
            video.evaluate('(v)=>v.pause()')
            with page.expect_download() as pending:
                page.get_by_role('link', name='Download', exact=True).click()
            downloaded = pending.value
            output = evidence / (stem + '.' + downloaded.suggested_filename.rsplit('.',1)[-1])
            downloaded.save_as(str(output))
            assert downloaded.failure() is None and output.stat().st_size > 1000
            job = next(job for job in read_jobs(page) if job['filename'] == downloaded.suggested_filename)
            created.append(job)
            details = {'download':str(output), 'bytes':output.stat().st_size, 'job':job, 'playback':[before,after]}
            details.update(inspect_video(output, nominal_duration, colors))
            return details

        dialog = completion()
        results['completion_auto_popup'] = True
        assert dialog.get_by_role('button', name='Close extension popup', exact=True).evaluate('(e)=>e===document.activeElement')
        for _ in range(14):
            page.keyboard.press('Tab')
            assert dialog.evaluate('(e)=>e.contains(document.activeElement)')
        page.keyboard.press('Shift+Tab')
        assert dialog.evaluate('(e)=>e.contains(document.activeElement)')
        page.set_viewport_size({'width':390,'height':844})
        box = dialog.bounding_box()
        assert box and box['y'] >= -1 and box['y'] + box['height'] <= 845, box
        assert page.evaluate('document.documentElement.scrollWidth === innerWidth')
        dialog.get_by_role('button', name='Not now', exact=True).scroll_into_view_if_needed()
        page.screenshot(path=str(evidence / 'mobile-popup.png'))
        results['mobile_popup'] = {'bounding_box':box, 'viewport_width':390, 'no_horizontal_overflow':True}
        dialog.get_by_role('button', name='Not now', exact=True).click()
        assert page.get_by_role('dialog').count() == 0
        page.set_viewport_size({'width':1440,'height':1000})
        original_colors = [(0.5,(255,0,0)),(1.5,(0,255,0)),(2.5,(0,0,255))]
        results['original'] = download_current('storyboard-3s',3,original_colors)
        assert results['original']['job']['motion'] == 'pan-right'
        assert results['original']['job']['prompt'] == 'Pan right'
        assert results['original']['job']['imageCount'] == 3
        page.get_by_role('button', name='Extend video', exact=True).click()
        dialog = completion()
        page.keyboard.press('Escape')
        assert page.get_by_role('dialog').count() == 0
        results['escape_closes_popup'] = True
        page.get_by_role('button', name='Extend video', exact=True).click()
        dialog = completion()
        dialog.get_by_label('Extension prompt', exact=True).fill('Zoom out')
        dialog.locator('input[aria-label="Add extension images"]').set_input_files([image_file('yellow',(255,255,0))])
        dialog.locator('.storyboard-image').wait_for()
        dialog.get_by_role('button', name='+3s', exact=True).click()
        dialog.get_by_role('button', name='Generate extension', exact=True).click()
        completion().get_by_role('button', name='Not now', exact=True).click()
        six_colors = original_colors + [(4.5,(255,255,0)),(5.5,(255,255,0))]
        results['extension'] = download_current('storyboard-6s',6,six_colors)
        assert results['extension']['job']['parentId'] == results['original']['job']['id']
        assert results['extension']['job']['motion'] == 'zoom-out'
        assert results['extension']['job']['prompt'] == 'Zoom out'
        page.screenshot(path=str(evidence / 'extended.png'), full_page=True)
        if not args.skip_second_extension:
            page.get_by_role('button', name='Extend video', exact=True).click()
            dialog = completion()
            dialog.get_by_label('Extension prompt', exact=True).fill('Still')
            dialog.get_by_role('button', name='Generate extension', exact=True).click()
            completion().get_by_role('button', name='Not now', exact=True).click()
            results['continuation'] = download_current('storyboard-9s',9,six_colors + [(7.5,(255,255,0)),(8.5,(255,255,0))])
            assert results['continuation']['job']['parentId'] == results['extension']['job']['id']
        # Cancellation must not offer extension or add a library entry.
        count_before_cancel = len(read_jobs(page))
        page.get_by_role('button', name='10s', exact=True).click()
        page.get_by_role('button', name='Generate video', exact=True).click()
        page.get_by_role('button', name='Cancel rendering', exact=True).click()
        page.wait_for_timeout(900)
        assert page.get_by_role('dialog').count() == 0
        assert len(read_jobs(page)) == count_before_cancel
        results['cancel_has_no_completion_popup'] = True
        page.reload(wait_until='networkidle')
        page.get_by_text('Renderer online' if args.url else 'Browser renderer ready', exact=True).wait_for()
        assert set(job['id'] for job in created).issubset({job['id'] for job in read_jobs(page)})
        page.get_by_role('button', name='My videos').click()
        latest = created[-1]
        card = page.locator('article.video-card').filter(has=page.locator(f'a[download="{latest["filename"]}"]'))
        card.get_by_role('button', name='Extend saved video', exact=True).click()
        completion()
        results['reload_persistence_and_extend_saved'] = True
        page.keyboard.press('Escape')
        for job in reversed(created):
            card = page.locator('article.video-card').filter(has=page.locator(f'a[download="{job["filename"]}"]'))
            card.get_by_role('button', name='Delete video', exact=True).click()
            card.wait_for(state='detached')
        results['final_ids'] = [job['id'] for job in read_jobs(page)]
        assert sorted(initial_ids) == sorted(results['final_ids'])
        assert not results['page_errors'] and not results['console_errors'] and not results['unexpected_http_requests']
        results['success'] = True
    except Exception as error:
        results['success'] = False
        results['error'] = str(error)
        results['traceback'] = traceback.format_exc()
        results['alerts'] = page.get_by_role('alert').all_inner_texts()
        page.screenshot(path=str(evidence / 'failure.png'), full_page=True)
    finally:
        results['created_ids'] = [job['id'] for job in created]
        (evidence / 'results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))
        browser.close()

if not results.get('success'):
    raise SystemExit(1)
