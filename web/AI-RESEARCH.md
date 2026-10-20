# Grok reference-to-video: verified contract and implementation

The AI scene integration uses xAI's `grok-imagine-video-1.5` model to generate
subject movement from the complete scene prompt and all selected reference
images in **one request**. This differs from the camera sequence renderer,
which plays still images in order with pan or zoom.

The contract below was checked against public source in xAI's official SDKs and
cookbook. The published Python `xai-sdk` 1.20.0 wheel and TypeScript
`@xai-official/sdk` 0.2.2 package were also checked with their registry integrity
digests. No paid generation request was made during this research. Direct
documentation and API connectivity were unavailable, so source inspection does
not establish that this account or environment can complete a live generation.

## One scene from several references

The app accepts **1–3 references** for an AI scene. Their order determines the
prompt tokens: `<IMAGE_0>`, `<IMAGE_1>`, and `<IMAGE_2>`. Describe what the subjects
do together, their surroundings, and the desired continuous shot. The entire
prompt is submitted, including surrounding whitespace; AI mode does not reduce
it to camera keywords. Browser multipart transport standardizes line breaks to
CRLF. Model output can still differ from the requested action or likeness.

The official cookbook demonstrates one whole-scene prompt, builds a cast from
one to three images, and submits those references together:

- [Prompt describing characters together in one scene](https://github.com/xai-org/xai-cookbook/blob/58b8d68bfc1ef8fff0a9c0561342e6d11d4b9571/examples/photo-to-talking-character/typescript/src/scene.ts#L33-L45)
- [Single generation request with the reference array](https://github.com/xai-org/xai-cookbook/blob/58b8d68bfc1ef8fff0a9c0561342e6d11d4b9571/examples/photo-to-talking-character/typescript/src/scene.ts#L55-L71)
- [Example accepts one to three characters](https://github.com/xai-org/xai-cookbook/blob/58b8d68bfc1ef8fff0a9c0561342e6d11d4b9571/examples/photo-to-talking-character/typescript/src/server.ts#L95-L110)

Three is this app's conservative limit. The checked REST schema does not specify
a `maxItems` value for `reference_images`; these sources do not establish the
provider's maximum beyond the supported examples.

## REST request and polling

The server sends `POST https://api.x.ai/v1/videos/generations` with
`Content-Type: application/json` and server-side Bearer authentication. A request
has this shape; the base64 strings below are placeholders:

```json
{
  "model": "grok-imagine-video-1.5",
  "prompt": "The people from <IMAGE_0> and <IMAGE_1> walk together through the garden from <IMAGE_2>, wave to each other, and smile. One continuous shot.",
  "reference_images": [
    { "url": "data:image/png;base64,<image-0>" },
    { "url": "data:image/jpeg;base64,<image-1>" },
    { "url": "data:image/png;base64,<image-2>" }
  ],
  "duration": 5,
  "aspect_ratio": "16:9",
  "resolution": "720p"
}
```

The wire format uses `reference_images` containing `{ "url": "..." }` objects.
Inputs can be JPEG, PNG, or WebP public URLs, base64 data URLs, or Files API
`file_id` objects. This implementation uses validated uploaded images encoded as
data URLs. It does not publish the uploads to obtain public image URLs.

The API supports generation durations of 1–15 seconds; this app exposes 3, 5,
and 10 seconds. The aspect ratio is `16:9`, `9:16`, or `1:1` according to the
selected landscape, portrait, or square format.

The start response contains `request_id`. Poll
`GET https://api.x.ai/v1/videos/{request_id}` with the same server-side
authentication. HTTP 202 can have an empty body and means the request remains
pending. Terminal states are `done`, `failed`, or `expired`; a failed job can
return HTTP 200, so the status field must be checked. A successful, permitted
result supplies `video.url`. If `video.respect_moderation` is false, no playable
URL is released.

The current service polls every five seconds for up to ten minutes, downloads
the temporary output promptly, validates it, and exports a local MP4. It does
not automatically retry the paid generation POST.

Sources:

- [REST endpoints, request ID, and empty HTTP 202 handling](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/resources/videos.ts#L24-L99)
- [Prompt, duration, and reference image request schema](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/generated/types.ts#L1489-L1534)
- [Image URL and file ID schema](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/generated/types.ts#L1817-L1828)
- [SDK converts image blobs to `{url: dataURL}`](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/porcelain.ts#L227-L231)
- [Result states, moderation, and temporary video URLs](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/README.md#L840-L866)

## 720p generation and explicitly upscaled 1080p export

The SDK's general resolution type includes `480p`, `720p`, and `1080p`. That
does not mean every generation mode supports all three. The official cookbook
specifically reports that **reference-to-video generates at 720p at most and
requesting 1080p returns HTTP 400**.

Accordingly, this app requests a 720p AI source and uses FFmpeg Lanczos scaling
to export 1920 × 1080 landscape, 1080 × 1920 portrait, or 1080 × 1080 square.
It preserves the generated aspect ratio with padding when necessary. Metadata
records the measured source dimensions plus `sourceResolution: "720p"`,
`outputResolution: "1080p"`, and `upscaled: true`. Upscaling creates a larger
export; it does not add native 1080p model detail. The service preserves an audio
track when the provider supplies one.

- [General resolution type](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/generated/types.ts#L4017-L4021)
- [Explicit reference-to-video 720p limit and 1080p error](https://github.com/xai-org/xai-cookbook/blob/58b8d68bfc1ef8fff0a9c0561342e6d11d4b9571/examples/grok-shorts/README.md#L294-L298)
- [Second official example confirms the 720p reference limit](https://github.com/xai-org/xai-cookbook/blob/58b8d68bfc1ef8fff0a9c0561342e6d11d4b9571/examples/photo-to-talking-character/README.md#L59-L61)

## Reference images, pinned frames, and camera sequences

| Input or mode | Meaning |
| --- | --- |
| `reference_images` | Style/content references considered together when generating one scene. They are not consecutive shots. |
| `image` | Starting-frame input for image-to-video. |
| `image` with `last_frame` or `keyframes` | Pinned first/last frames or timed intermediate frames on supported models; a different contract from free scene references. |
| Camera sequence in this app | Local rendering of one to six still images in order, with supported pan/zoom instructions. It does not synthesize subject movement. |

The Python SDK documents exact endpoint frame pins and up to four interior
keyframes for `grok-imagine-video-1.5`. Its official keyframe example also
explicitly excludes 1080p when frames are pinned. The AI scene service does not
send pinned-frame inputs. AI extension is currently disabled in this app;
camera-sequence extensions remain a separate local feature.

- [Generation modes and pinned-frame semantics](https://github.com/xai-org/xai-sdk-python/blob/1d9e1dffc9a0521ede0e6bc7f2b906177b940d34/src/xai_sdk/sync/video.py#L311-L350)
- [Pinned-frame example and resolution restriction](https://github.com/xai-org/xai-sdk-python/blob/1d9e1dffc9a0521ede0e6bc7f2b906177b940d34/examples/sync/video_keyframes.py#L1-L27)

## Authentication, privacy, and billing

The server needs `XAI_API_KEY` supplied securely, API account access, and network
access to `api.x.ai`. Generated downloads currently accept only the documented
`vidgen.x.ai` HTTPS host. API credentials are sent only to `api.x.ai`; CDN
downloads receive no Authorization header and cannot redirect. Keys are not
placed in the browser app, standalone HTML, saved job metadata, or repository.

AI generation sends the selected images and full prompt to xAI. The offline
standalone HTML has no server key and offers local camera rendering instead.
Uploaded source files and temporary provider downloads are removed after local
work finishes or is removed. Completed AI exports and their prompt metadata stay
in ignored `.data/ai-videos/`, limited to the 50 most recent exports. Removing
local files does not establish deletion from xAI's systems.

**xAI does not provide remote video-generation cancellation in the checked
contract.** “Stop waiting and remove” aborts local work and removes the local
job. The remote generation can continue and incur charges, including after an
application timeout or restart. Avoid blindly resubmitting after an uncertain
start response; first check the provider account because the first request may
already have been accepted.

The official SDK exposes actual request cost as `usage.cost_in_usd_ticks`;
divide by 10,000,000,000 to obtain USD. This app currently does not display or
persist that usage field. No fixed per-second price was verified from these
sources, so this document does not quote a price. Check current xAI account
pricing and spending limits before real generation.

- [API host and `XAI_API_KEY` authentication](https://github.com/xai-org/xai-sdk-python/blob/1d9e1dffc9a0521ede0e6bc7f2b906177b940d34/src/xai_sdk/client.py#L49-L56)
- [REST Bearer authentication](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/http.ts#L175-L185)
- [Stopping polling does not cancel generation or billing](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/README.md#L862-L864)
- [Request cost units](https://github.com/xai-org/xai-sdk-ts/blob/857ea432df656aa2a315a8d42d13d69e160c65d7/src/generated/types.ts#L2138-L2145)

See [server/xai-service.js](server/xai-service.js) for this app's request,
download, validation, upscale, cleanup, and persistence behavior. Source-contract
verification and mock-provider tests are separate from a successful paid,
end-to-end generation with real credentials.
