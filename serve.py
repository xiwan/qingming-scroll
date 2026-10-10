"""本地预览用的静态服务器：和 python -m http.server 一样，但支持 Range 请求。

Chrome 拖动 <video> 进度要靠 Range（206 Partial Content）；标准库的 http.server 不支持，
在那上面 seek 会跳回开头。部署到 nginx / S3 / CDN / GitHub Pages 等都自带 Range，不需要这个。

用法: python3 serve.py [端口，默认 8765]      然后打开 http://127.0.0.1:8765/
"""
import http.server
import os
import re
import sys


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        a, b = m.groups()
        if a:
            start, end = int(a), min(int(b) if b else size - 1, size - 1)
        else:                                     # bytes=-N：最后 N 个字节
            start, end = max(0, size - int(b or 0)), size - 1
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._left = end - start + 1
        return f

    def copyfile(self, src, dst):
        left = getattr(self, "_left", None)
        if left is None:
            return super().copyfile(src, dst)
        while left > 0:
            buf = src.read(min(1 << 16, left))
            if not buf:
                break
            dst.write(buf)
            left -= len(buf)
        self._left = None

    def end_headers(self):
        if not self.headers.get("Range"):
            self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):   # 浏览器拖进度时会掐掉旧的 Range 请求
            super().handle_error(request, client_address)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    srv = Server(("127.0.0.1", port), RangeHandler)
    print(f"清明上河图 · 卷轴互动版  →  http://127.0.0.1:{port}/   （Ctrl+C 停止）")
    try:
        srv.serve_forever()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
