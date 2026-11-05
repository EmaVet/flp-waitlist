# Builds public/index.html (shared, server-backed) from index.html (GitHub Pages, on-device).
import re, shutil, os
s = open('index.html').read()
m = re.search(r'<script>\n/\* Standalone mode.*?</script>\n', s, re.S)
assert m, 'local shim not found'
shared = open('shared-shim.html').read()
s = s[:m.start()] + shared + s[m.end():]
s = s.replace('<meta name="apple-mobile-web-app-title" content="Waitlist">', '<meta name="apple-mobile-web-app-title" content="FLP Waitlist">')
os.makedirs('public', exist_ok=True)
open('public/index.html', 'w').write(s)
shutil.copy('icon.png', 'public/icon.png')
print('built public/index.html', len(s))
