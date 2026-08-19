import http.server, datetime, urllib.parse
LOG = '/tmp/ac1-exfil-captured.log'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(LOG, 'a') as f:
            f.write(f"{datetime.datetime.now().isoformat()} GET {self.path}\n")
            f.write(f"  UA={self.headers.get('User-Agent','')}\n")
        self.send_response(200); self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'ok')
    do_POST = do_GET
    def log_message(self, *a): pass
http.server.HTTPServer(('0.0.0.0', 8899), H).serve_forever()
