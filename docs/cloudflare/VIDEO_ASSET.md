# Contest video asset

The submission video is [cloudflare-agent-collaboration-demo.mp4](evidence/contest-final-video-run-2026-10-03/cloudflare-agent-collaboration-demo.mp4). This is the updated asset requested for the contest; it replaces the older `nexus-contest-final-demo.mp4` recording referenced by archived October 3 notes.

## File checks

- Format: MP4 container, H.264 video, AAC audio, 1920×1080 at 15 fps.
- Duration: 434.820 seconds (7:14.820), within the contest's 5–10 minute range.
- Size: 14,428,977 bytes (about 13.8 MiB), below 2 GiB.
- SHA-256: `ce6582112e512692810cd0887cece9194ac535e1ec29f075e8dd60220c4b7085`.
- Full decode: `ffmpeg -v error -i cloudflare-agent-collaboration-demo.mp4 -f null -` completed without errors. The audio stream also decoded fully.
- The video labels its terminal section as a captured execution replay and labels Nexus as the demonstration harness. Sampled frames show service-first opening cards followed by the Worker retrieval and Consumer reassessment evidence.
- Narration is locally synthesized, as disclosed in the supplied recording materials. Technical audio decoding passed; a human listening review of voice intelligibility and word-for-word script alignment remains outstanding.

## Capture-to-source mapping

The associated run record identifies run `6e852c91-5371-43b7-ac7a-90376a2c11a8`, Nexus source HEAD `731f5d44c7b548938d1f011bd88269b09df2bff4`, and contest demo HEAD `98a8a813430cbd0dc9b54ee97a594f0bc7087cd6`. The freeze manifest also records source-file hashes from a dirty working tree. Those captured demo files, including the then-untracked restricted validation executor, have been recovered into `demo/`; their source snapshot hashes were checked during transfer. The originally committed demo HEAD alone did not contain that complete snapshot.

The captured CLI client bundle hash was `56c72f37cb8130ae2b32d9730fdba499fbed2ab7c56b77d7cdda29c7bb479857`; the current target checkout's `cli/dist/client.js` hash is `78077e6bda5533dbf2af3f075c8072d8bb0771df0ab7c43c69b54e3cbc72a689`. This is a consequential source delta. No clean Cloudflare-backed replay has been made from the target tree, and the external protected transport and fixed account resources used by the captured run are not included as a judge-ready bootstrap. The video is bounded evidence for its recorded environment, not proof that a judge can reproduce the final tree.

The stable public links are:

- Watch: [GitHub video page](https://github.com/mikeholownych/nexus-code/blob/main/docs/cloudflare/evidence/contest-final-video-run-2026-10-03/cloudflare-agent-collaboration-demo.mp4)
- Download: [Raw MP4](https://raw.githubusercontent.com/mikeholownych/nexus-code/main/docs/cloudflare/evidence/contest-final-video-run-2026-10-03/cloudflare-agent-collaboration-demo.mp4)

The file is committed in the existing target repository and both URLs were checked anonymously. It is contest evidence, separate from the Nexus Code client release assets; no alternate repository or hosting account is required.
