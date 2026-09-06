"""Export an allowlisted source tree. Never copies Git history or runtime data."""
import argparse
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'.gitignore', '.gitattributes', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json', 'run.ps1'}
DIRECTORIES = {'src', 'desktop', 'ui', 'scripts', 'docs', '.github'}
TEXT_SUFFIXES = {'.rs', '.cjs', '.js', '.html', '.css', '.ps1', '.py', '.md', '.toml', '.lock', '.json', '.yml', '.yaml'}
BINARY_FILES = {'desktop/assets/icon.png', 'desktop/assets/icon.ico'}
RULES = {
    'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'access token': r'(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{16,}',
    'bearer credential': r'Bearer\s+[A-Za-z0-9_.-]{24,}',
    'JWT': r'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}',
    'personal profile path': r'(?i)[a-z]:[\\/]Users[\\/](?!YOUR_USER|<|Public|Default)[^\\/\s`]+',
    'credential value': r'''(?i)["'](?:access_token|refresh_token|api_key|password)["']\s*:\s*["'][A-Za-z0-9_./+=-]{16,}["']''',
}

def source_files(root=ROOT):
    candidates = [root / name for name in ROOT_FILES if (root / name).exists()]
    for directory in DIRECTORIES:
        if (root / directory).exists():
            candidates.extend((root / directory).rglob('*'))
    for item in sorted(candidates):
        relative = item.relative_to(root)
        if relative.parts[0] not in DIRECTORIES and relative.as_posix() not in ROOT_FILES:
            continue
        if item.is_symlink():
            raise ValueError(f'Symlink is not allowed: {relative}')
        if not item.is_file():
            continue
        name = relative.as_posix()
        if name not in ROOT_FILES and name not in BINARY_FILES and item.suffix not in TEXT_SUFFIXES:
            raise ValueError(f'Unexpected source file: {name}')
        if any(part in {'.git', 'node_modules', '__pycache__', 'captures', 'private'} for part in relative.parts):
            raise ValueError(f'Private/generated directory in sources: {name}')
        if re.search(r'(?i)(?:^|/)(?:\.env(?:\.|$)|filter-sessions\.|history[^/]*\.json$|.*(?:clipboard|screenshot).*)', name):
            raise ValueError(f'Private/generated file: {name}')
        yield item, relative

def scan(files):
    findings = []
    for item, relative in files:
        if relative.as_posix() in BINARY_FILES:
            continue
        text = item.read_text(encoding='utf-8')
        for name, pattern in RULES.items():
            for match in re.finditer(pattern, text):
                findings.append(f'{relative}:{text.count(chr(10), 0, match.start()) + 1}: {name}')
    if findings:
        raise ValueError('Publication scan failed (values hidden):\n' + '\n'.join(findings))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / '.publish' / 'Librium')
    args = parser.parse_args()
    files = list(source_files())
    scan(files)
    if args.check:
        print(f'PASS: {len(files)} allowlisted files scanned')
        return
    destination = args.output.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Output directory must be new or empty; existing data is never deleted')
    if destination == ROOT or destination in ROOT.parents:
        raise ValueError('Output cannot be the source directory or its parent')
    destination.mkdir(parents=True, exist_ok=True)
    for item, relative in files:
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, output)
    print(f'Exported {len(files)} source files; no Git history or runtime data included')

if __name__ == '__main__':
    main()
