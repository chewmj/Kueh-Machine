#!/usr/bin/env python3
"""Serve the site locally, telling the browser to check for newer files on
every load.

Python's plain http.server says nothing about caching, so browsers guess and
can keep showing an old index.html or recipes-seed.js for days after they've
changed. Used by "Start Kueh Machine.command".

Usage:  python3 tools/serve.py [port]
"""

import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Still cached, but always checked with the server before use.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    http.server.ThreadingHTTPServer(('', port), handler).serve_forever()


if __name__ == '__main__':
    main()
