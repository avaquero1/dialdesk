# images

The sandbox images are built from this repo in Phase 1: a browse image (Chromium and a small driver that loads pages
through the egress proxy and returns their text and screenshots) and a compute image (the `engine` binary alone). The
manager runs them pinned by digest, never by tag, so every job starts from exactly the image that was reviewed.
