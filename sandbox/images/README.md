# images

- `browse/`: the browse sandbox. Debian's Chromium (the real binary, not Debian's wrapper, which exports Google API
  keys into the environment; no setuid helper) and `app/driver.mjs`, which opens the job's URLs through the egress
  proxy, returns their text (hidden text and comments too, so the guard sees planted orders) and screenshots, and
  holds the browser until release or kill. Target `probe` adds `app/probes.mjs` for the containment tests only.
- The compute image is the engine's: `engine/Dockerfile`, built by `make engine-image` (a static binary on scratch).

`make images` builds both browse targets. The base is pinned by digest; on the sandbox machine the manager runs each
image by digest, so every job starts from the image that was tested.
