#!/usr/bin/env python3
"""Test AI-scene UI contracts with mocked provider/API responses, never live AI.

Requires Python Playwright, Chromium, FFmpeg, and ffprobe. The production HTML
and assets are served through offline Playwright routes. A real FFmpeg-generated
1080p test fixture stands in for the provider result. This verifies references,
complete prompt transport, labels, playback, and download; it does not validate
Grok generation quality or use an xAI account/key.
"""
import argparse
import base64
import email.policy
import json
import mimetypes
import struct
import subprocess
import traceback
import zlib
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dist', type=Path, default=Path(__file__).resolve().parents[1] / 'dist')
parser.add_argument('--browser', default='/usr/bin/chromium')
parser.add_argument('--evidence-dir', type=Path, default=Path('/tmp/vanta-ai-ui-smoke'))
args = parser.parse_args()
dist = args.dist.resolve()
evidence = args.evidence_dir.resolve()
evidence.mkdir(parents=True, exist_ok=True)
fixture = evidence / 'mock-provider-result.mp4'
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=1920x1080:rate=24','-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-an','-movflags','+faststart',str(fixture)],check=True)
origin = 'http://localhost:47873'
prompt = '  <IMAGE_0> and <IMAGE_1> walk side by side into the same rain-lit station.\nThey exchange a blue umbrella, smile naturally, then turn toward the train together. Pan left slowly in one continuous shot; keep both identities and outfits, no cuts or separate slides.  '
job = {'id':'e8f3dd60-4b80-4f38-8246-2632a3cc1f13','status':'queued','progress':0,'duration':3,'addedDuration':3,'parentId':None,'engine':'ai','provider':'xai','upscaled':True,'extendable':False,'nativeResolution':'720p','imageCount':2,'prompt':prompt,'motion':'still','format':'landscape','width':1920,'height':1080,'createdAt':'2026-10-19T12:00:00.000Z','completedAt':None,'filename':'mock-ai-scene.mp4','extension':'mp4','fileUrl':None,'error':None}
results = {'provider':'MOCKED API/provider responses; no live generation or credentials','offline':True,'page_errors':[],'console_errors':[],'unexpected_requests':[]}
state = {'submitted':False,'complete':False,'polls':0}
file_url = None

def png(color):
    def chunk(kind, body):
        return struct.pack('>I', len(body))+kind+body+struct.pack('>I', zlib.crc32(kind+body)&0xffffffff)
    raw=(b'\x00'+bytes(color)*640)*360
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',640,360,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')

references = [{'name':'subject-red.png','mimeType':'image/png','buffer':png((255,0,0))},{'name':'subject-blue.png','mimeType':'image/png','buffer':png((0,0,255))}]

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.browser,headless=True,args=['--no-sandbox'])
    context=browser.new_context(offline=True,accept_downloads=True,viewport={'width':1440,'height':1000})
    def route(route):
        request=route.request
        parsed=urlsplit(request.url)
        if parsed.scheme not in ['http','https']:
            return route.continue_()
        if f'{parsed.scheme}://{parsed.netloc}' != origin:
            results['unexpected_requests'].append(request.url)
            return route.abort()
        path=parsed.path
        def reply(body,status=200):
            route.fulfill(status=status,json=body)
        if path=='/api/health': return reply({'status':'ok','mode':'server'})
        if path=='/api/capabilities': return reply({'ai':True,'local':True,'extension':'mp4'})
        if path=='/api/videos' and request.method=='GET': return reply({'videos':[{**job,'status':'completed','progress':100,'fileUrl':file_url}] if state['complete'] else []})
        if path=='/api/videos' and request.method=='POST':
            message=BytesParser(policy=email.policy.default).parsebytes(('Content-Type: '+request.headers['content-type']+'\r\n\r\n').encode()+request.post_data_buffer)
            fields={}
            images=[]
            for part in message.iter_parts():
                name=part.get_param('name',header='content-disposition')
                body=part.get_payload(decode=True)
                if name=='image': images.append({'filename':part.get_filename(),'size':len(body),'matches_reference':any(body==reference['buffer'] for reference in references)})
                else: fields.setdefault(name,[]).append(body.decode())
            results['multipart']={'fields':fields,'images':images,'authorization_header_present':'authorization' in request.headers}
            state['submitted']=True
            return reply(job,202)
        if path==f'/api/videos/{job["id"]}' and request.method=='GET':
            state['polls']+=1
            if state['polls']<2: return reply({**job,'status':'processing','progress':25})
            state['complete']=True
            return reply({**job,'status':'completed','progress':100,'completedAt':'2026-10-19T12:00:03.000Z','fileUrl':file_url})
        if path==f'/api/videos/{job["id"]}/file':
            return route.fulfill(status=200,content_type='video/mp4',body=fixture.read_bytes())
        candidate=(dist/('index.html' if path=='/' else unquote(path.lstrip('/')))).resolve()
        if candidate.is_relative_to(dist) and candidate.is_file():
            return route.fulfill(status=200,content_type=mimetypes.guess_type(str(candidate))[0] or 'application/octet-stream',body=candidate.read_bytes())
        results['unexpected_requests'].append(request.url)
        route.abort()
    context.route('http://**/*',route)
    context.route('https://**/*',route)
    page=context.new_page()
    page.on('pageerror',lambda e:results['page_errors'].append(str(e)))
    page.on('console',lambda m:results['console_errors'].append(m.text) if m.type=='error' else None)
    try:
        page.goto(origin,wait_until='networkidle')
        page.get_by_text('Renderer online',exact=True).wait_for()
        # Offline Chromium downloads do not use Playwright HTTP routing. Supply
        # the real fixture as an in-memory result, preserving an offline test.
        file_url=page.evaluate('(data)=>URL.createObjectURL(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:"video/mp4"}))',base64.b64encode(fixture.read_bytes()).decode())
        assert page.locator('#generation-engine').input_value()=='ai'
        field=page.locator('input[aria-label="Add images"]')
        field.set_input_files(references*2)
        page.get_by_role('alert').wait_for()
        assert '3 reference images' in page.get_by_role('alert').inner_text()
        page.get_by_role('button',name='Dismiss error',exact=True).click()
        field.set_input_files(references)
        page.wait_for_function('document.querySelectorAll(".settings-panel .storyboard-image").length===2')
        assert page.get_by_role('button',name='Move image 1 later',exact=True).count()==0
        page.get_by_label('Full scene prompt',exact=True).fill(prompt)
        page.get_by_role('button',name='3s',exact=True).click()
        page.get_by_role('button',name='Generate AI scene',exact=True).click()
        page.get_by_role('link',name='Download',exact=True).wait_for(timeout=15000)
        assert state['submitted']
        assert results['multipart']['fields']['engine']==['ai']
        # Multipart FormData encodes textarea line endings as CRLF. Preserve
        # every word and space while accounting for that browser wire format.
        assert results['multipart']['fields']['prompt']==[prompt.replace('\n','\r\n')]
        results['full_prompt_preserved_with_multipart_CRLF'] = True
        assert len(results['multipart']['images'])==2 and all(image['matches_reference'] for image in results['multipart']['images'])
        assert not results['multipart']['authorization_header_present']
        assert '1080p (upscaled)' in page.locator('.preview-toolbar').inner_text()
        assert page.get_by_role('button',name='Extend video',exact=True).count()==0
        assert page.get_by_role('dialog',name='Keep the story going?',exact=True).count()==0
        video=page.get_by_label('Generated video',exact=True)
        video.evaluate('(v)=>v.play()')
        before=video.evaluate('(v)=>v.currentTime')
        page.wait_for_timeout(600)
        after=video.evaluate('(v)=>v.currentTime')
        assert after>before
        video.evaluate('(v)=>v.pause()')
        results['playback']=[before,after]
        with page.expect_download() as pending: page.get_by_role('link',name='Download',exact=True).click()
        downloaded=pending.value
        output=evidence/'downloaded-mocked-ai.mp4'
        downloaded.save_as(str(output))
        assert downloaded.failure() is None and output.stat().st_size>1000
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=codec_name,width,height','-show_entries','format=duration,size','-of','json',str(output)],text=True))
        assert probe['streams'][0]['width']==1920 and probe['streams'][0]['height']==1080
        results['download']={'path':str(output),'bytes':output.stat().st_size,'ffprobe':probe}
        page.screenshot(path=str(evidence/'mocked-ai.png'),full_page=True)
        page.get_by_role('button',name='My videos').click()
        page.locator('article.video-card').wait_for()
        assert page.get_by_role('button',name='Extend saved video',exact=True).count()==0
        assert not results['unexpected_requests'] and not results['page_errors'] and not results['console_errors']
        results['success']=True
    except Exception as error:
        results['success']=False
        results['error']=str(error)
        results['traceback']=traceback.format_exc()
        results['alerts']=page.get_by_role('alert').all_inner_texts()
        page.screenshot(path=str(evidence/'failure.png'),full_page=True)
    finally:
        (evidence/'results.json').write_text(json.dumps(results,indent=2))
        print(json.dumps(results,indent=2))
        browser.close()
if not results.get('success'):
    raise SystemExit(1)
