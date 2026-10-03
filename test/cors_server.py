# 带 CORS 回声 + Range(206) 支持的静态服务器：模拟扩展 DNR 规则注入的响应头
# （Access-Control-Allow-Origin 回显请求 Origin + Allow-Credentials），
# 以及真实 CDN 的分段服务，用于验证 CORS 克隆取帧"按需拉取、不整包下载"。
# 画布污染不受此影响：媒体元素未设 crossorigin 属性时一律污染（no-cors 加载）。
# 用法：python cors_server.py <port>
import io
import os
import re
import socketserver
import sys
import http.server

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Credentials', 'true')
        super().end_headers()

    def send_head(self):
        # 对有 Range 头的文件请求返回 206 分段（SimpleHTTPRequestHandler 本身不支持 Range）
        range_header = self.headers.get('Range')
        if range_header and not self.path.endswith('/'):
            path = self.translate_path(self.path)
            if os.path.isfile(path):
                m = re.match(r'bytes=(\d*)-(\d*)$', range_header.strip())
                size = os.path.getsize(path)
                start = int(m.group(1)) if m and m.group(1) else 0
                end = int(m.group(2)) if m and m.group(2) else size - 1
                end = min(end, size - 1)
                if start < size and start <= end:
                    length = end - start + 1
                    with open(path, 'rb') as f:
                        f.seek(start)
                        data = f.read(length)
                    self.send_response(206)
                    self.send_header('Content-Type', self.guess_type(path))
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Content-Length', str(length))
                    self.end_headers()
                    return io.BytesIO(data)
        return super().send_head()

    def log_message(self, fmt, *args):
        sys.stdout.write('[srv] %s\n' % (fmt % args))
        sys.stdout.flush()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    os.chdir(ROOT)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('0.0.0.0', port), Handler) as httpd:
        print(f'serving with CORS echo + Range on 0.0.0.0:{port}, root={ROOT}')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
