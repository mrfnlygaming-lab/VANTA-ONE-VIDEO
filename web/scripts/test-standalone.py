#!/usr/bin/env python3
"""Exercise the standalone build without a server or network requests.

Requires Python Playwright, Chromium, FFmpeg, and ffprobe. Example:
  python web/scripts/test-standalone.py

The exact HTML is supplied through Playwright routing at an offline localhost
origin, and separately loaded into an opaque about:blank document. This does not
claim to validate file:// navigation or change managed browser policy. Each run
uses a fresh isolated browser context and deletes its generated library entry.
"""
from playwright.sync_api import sync_playwright
from pathlib import Path
import argparse, hashlib, json, subprocess, traceback

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--html', type=Path, default=Path(__file__).resolve().parents[1] / 'dist/VANTA-OPEN.html')
parser.add_argument('--browser', default='/usr/bin/chromium')
parser.add_argument('--evidence-dir', type=Path, default=Path('/tmp/vanta-standalone-smoke'))
args = parser.parse_args()
html_path = args.html.resolve()
evidence = args.evidence_dir.resolve()
evidence.mkdir(parents=True, exist_ok=True)
html = html_path.read_text()
virtual_url = 'http://localhost:47871/VANTA-OPEN.html'
results = {'context': 'exact HTML fulfilled from disk at offline localhost origin; file:// is not exercised', 'html_sha256':hashlib.sha256(html.encode()).hexdigest(), 'console_errors':[], 'page_errors':[], 'document_requests_fulfilled':0, 'unexpected_http_requests':[], 'offline':True}
instrumentation = '''(() => {
  window.__vantaTracks = []; window.__vantaRecorders = [];
  const capture = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function(...args) {
    const stream = capture.apply(this, args); window.__vantaTracks.push(...stream.getTracks()); return stream;
  };
  const Recorder = window.MediaRecorder;
  window.MediaRecorder = new Proxy(Recorder, { construct(target,args) { const recorder = new target(...args); window.__vantaRecorders.push(recorder); return recorder; } });
})();'''

def track_states(page):
    return page.evaluate('({tracks:window.__vantaTracks.map(t=>t.readyState),recorders:window.__vantaRecorders.map(r=>r.state)})')

def stored(page):
    return page.evaluate('''() => new Promise((resolve,reject)=>{const r=indexedDB.open('vanta-motion-studio',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('videos');const get=tx.objectStore('videos').getAll();get.onsuccess=()=>{resolve(get.result.map(x=>({id:x.id,size:x.blob.size,job:x.job})));db.close()};get.onerror=()=>reject(get.error)};r.onerror=()=>reject(r.error)})''')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True,offline=True)
    context.add_init_script(instrumentation)
    def route(request_route):
        if request_route.request.url == virtual_url:
            results['document_requests_fulfilled'] += 1
            request_route.fulfill(status=200,content_type='text/html',body=html)
        else:
            results['unexpected_http_requests'].append(request_route.request.url)
            request_route.abort()
    context.route('http://**/*', route)
    context.route('https://**/*', route)
    page = context.new_page()
    page.on('console',lambda m:results['console_errors'].append(m.text) if m.type=='error' else None)
    page.on('pageerror',lambda e:results['page_errors'].append(str(e)))
    try:
        page.goto(virtual_url,wait_until='networkidle')
        page.get_by_text('Browser renderer ready',exact=True).wait_for()
        results['renderer_ready'] = True
        results['initial_stored_ids'] = [v['id'] for v in stored(page)]
        page.get_by_role('button',name='No image handy? Try an example').click()
        page.get_by_alt_text('Your starting frame',exact=True).wait_for()
        page.locator('#motion').select_option('pan-right')
        page.get_by_role('button',name='3s',exact=True).click()
        page.get_by_role('button',name='Generate video',exact=True).click()
        page.get_by_role('link',name='Download',exact=True).wait_for(timeout=20000)
        video=page.get_by_label('Generated video',exact=True)
        page.wait_for_function('document.querySelector("video")?.readyState>=1')
        results['metadata']=video.evaluate('(v)=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight,mime:v.currentSrc})')
        video.evaluate('(v)=>v.play()')
        before=video.evaluate('(v)=>v.currentTime')
        page.wait_for_timeout(700)
        after=video.evaluate('(v)=>v.currentTime')
        results['playback']={'before':before,'after':after,'advanced':after>before}
        video.evaluate('(v)=>v.pause()')
        page.screenshot(path=str(evidence / 'generated.png'),full_page=True)
        with page.expect_download() as info:
            page.get_by_role('link',name='Download',exact=True).click()
        download=info.value
        output=evidence/('output.'+download.suggested_filename.rsplit('.',1)[-1])
        download.save_as(str(output))
        results['download']={'path':str(output),'filename':download.suggested_filename,'size':output.stat().st_size,'failure':download.failure()}
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt', '-show_entries', 'format=duration,size', '-of', 'json', str(output)], text=True))
        results['ffprobe'] = probe
        assert 2.9 <= float(probe['format']['duration']) <= 3.6
        stream = probe['streams'][0]
        assert (stream['width'], stream['height']) == (1280, 720)
        assert stream['codec_name'] == ('h264' if output.suffix == '.mp4' else 'vp9') or (output.suffix == '.webm' and stream['codec_name'] == 'vp8')
        def frame_bytes(position):
            return subprocess.check_output(['ffmpeg','-hide_banner','-loglevel','error',*position,'-i',str(output),'-frames:v','1','-vf','scale=320:180,format=gray','-f','rawvideo','-'])
        first_frame = frame_bytes(['-ss','0'])
        last_frame = frame_bytes(['-sseof','-0.15'])
        assert first_frame and len(first_frame) == len(last_frame)
        results['motion_mean_absolute_difference'] = sum(abs(a-b) for a,b in zip(first_frame,last_frame)) / len(first_frame)
        assert results['motion_mean_absolute_difference'] > 1
        completed=stored(page)
        results['completed_stored'] = completed
        assert len(completed)==len(results['initial_stored_ids'])+1
        results['completed_cleanup']=track_states(page)
        assert all(s=='ended' for s in results['completed_cleanup']['tracks'])
        assert all(s=='inactive' for s in results['completed_cleanup']['recorders'])
        # Exercise a real 10-second recording and cancel while it is active.
        page.get_by_role('button',name='10s',exact=True).click()
        page.get_by_role('button',name='Generate video',exact=True).click()
        page.get_by_role('button',name='Cancel rendering',exact=True).wait_for()
        page.wait_for_timeout(900)
        results['before_cancel']=track_states(page)
        assert results['before_cancel']['tracks'][-1]=='live'
        page.get_by_role('button',name='Cancel rendering',exact=True).click()
        page.wait_for_function('window.__vantaTracks.every(t=>t.readyState==="ended")')
        results['after_cancel']=track_states(page)
        assert all(s=='inactive' for s in results['after_cancel']['recorders'])
        assert page.get_by_role('button',name='Generate video',exact=True).is_enabled()
        assert len(stored(page))==len(completed)
        # Native headless Chromium does not background tabs; induce its visibility event.
        page.get_by_role('button',name='Generate video',exact=True).click()
        page.get_by_role('button',name='Cancel rendering',exact=True).wait_for()
        page.wait_for_timeout(700)
        page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))')
        page.get_by_role('alert').wait_for()
        results['visibility_failure']={'mechanism':'synthetic visibilitychange with document.hidden=true; headless Chromium does not background tabs','message':page.get_by_role('alert').inner_text()}
        page.wait_for_function('window.__vantaTracks.every(t=>t.readyState==="ended")')
        results['after_visibility_failure']=track_states(page)
        assert all(s=='inactive' for s in results['after_visibility_failure']['recorders'])
        assert page.get_by_role('button',name='Generate video',exact=True).is_enabled()
        assert len(stored(page))==len(completed)
        page.evaluate('delete document.hidden')
        page.get_by_role('button',name='Dismiss error',exact=True).click()
        # The error path must release resources and permit another real recording.
        page.get_by_role('button',name='Generate video',exact=True).click()
        page.get_by_role('button',name='Cancel rendering',exact=True).wait_for()
        page.wait_for_timeout(700)
        results['recovery_recording']=track_states(page)
        assert results['recovery_recording']['tracks'][-1]=='live'
        page.get_by_role('button',name='Cancel rendering',exact=True).click()
        page.wait_for_function('window.__vantaTracks.every(t=>t.readyState==="ended")')
        page.reload(wait_until='networkidle')
        page.get_by_text('Browser renderer ready',exact=True).wait_for()
        reloaded=stored(page)
        results['reload_stored_ids']=[v['id'] for v in reloaded]
        assert sorted(v['id'] for v in completed)==sorted(v['id'] for v in reloaded)
        page.get_by_role('button',name='My videos').click()
        page.locator('article.video-card').wait_for()
        results['library_persisted']=page.locator('article.video-card').count()==len(completed)
        test_filename=results['download']['filename']
        card=page.locator('article.video-card').filter(has=page.locator(f'a[download="{test_filename}"]'))
        card.get_by_role('button',name='Delete video',exact=True).click()
        card.wait_for(state='detached')
        results['final_stored_ids']=[v['id'] for v in stored(page)]
        assert sorted(results['initial_stored_ids'])==sorted(results['final_stored_ids'])
        page.get_by_role('button',name='Create video',exact=True).click()
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(evidence / 'mobile.png'),full_page=True)
        results['mobile_dimensions']=page.evaluate('({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth})')
        assert results['mobile_dimensions']['viewport']==results['mobile_dimensions']['scrollWidth']
        # This intentionally opaque document exercises the storage-unavailable path.
        opaque=context.new_page()
        if opaque.evaluate('typeof window.__vantaTracks') == 'undefined':
            opaque.evaluate(instrumentation)
        opaque.set_content(html,wait_until='networkidle')
        opaque.get_by_text('Browser renderer ready',exact=True).wait_for(timeout=10000)
        results['opaque_origin']=opaque.evaluate('({origin:origin,secure:isSecureContext,randomUUID:typeof crypto.randomUUID})')
        opaque.get_by_role('button',name='No image handy? Try an example').click()
        opaque.get_by_alt_text('Your starting frame',exact=True).wait_for()
        opaque.get_by_role('button',name='3s',exact=True).click()
        opaque.get_by_role('button',name='Generate video',exact=True).click()
        opaque.get_by_role('link',name='Download',exact=True).wait_for(timeout=20000)
        results['opaque_storage_warning']=opaque.get_by_role('alert').inner_text()
        assert 'Browser storage is unavailable or full.' in results['opaque_storage_warning']
        with opaque.expect_download() as opaque_info:
            opaque.get_by_role('link',name='Download',exact=True).click()
        opaque_download=opaque_info.value
        opaque_output=evidence/('opaque-output.'+opaque_download.suggested_filename.rsplit('.',1)[-1])
        opaque_download.save_as(str(opaque_output))
        results['opaque_download']={'path':str(opaque_output),'size':opaque_output.stat().st_size,'failure':opaque_download.failure()}
        opaque.close()
        assert not results['unexpected_http_requests']
        assert not results['page_errors']
        assert not results['console_errors']
        results['success']=True
    except Exception as error:
        results['success']=False
        results['error']=str(error)
        results['traceback']=traceback.format_exc()
        page.screenshot(path=str(evidence / 'failure.png'),full_page=True)
        if 'opaque' in locals() and not opaque.is_closed():
            results['opaque_alerts'] = opaque.get_by_role('alert').all_inner_texts()
            opaque.screenshot(path=str(evidence / 'opaque-failure.png'),full_page=True)
    finally:
        (evidence / 'results.json').write_text(json.dumps(results,indent=2))
        print(json.dumps(results,indent=2))
        browser.close()

if not results.get("success"):
    raise SystemExit(1)
