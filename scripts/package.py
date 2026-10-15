"""Create a dependency-free archive for Chrome's Load unpacked action."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
target = root / 'dist' / 'openlinks-chrome.zip'
target.parent.mkdir(exist_ok=True)
files = [root / 'README.md', *sorted((root / 'extension').rglob('*'))]
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for path in files:
        if path.is_file():
            archive.write(path, path.relative_to(root))
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert 'extension/manifest.json' in archive.namelist()
print(target)
