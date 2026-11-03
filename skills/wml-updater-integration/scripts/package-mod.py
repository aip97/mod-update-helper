#!/usr/bin/env python3
"""Build a conservative WML Mod Updater ZIP using only Python's standard library."""
import argparse
from datetime import date
import os
from pathlib import Path
import re
import stat
import zipfile


EXTENSIONS = set('js mjs json css html md txt png jpg jpeg webp gif svg ico woff woff2 ttf otf mp3 ogg wav'.split())
MUTABLE = re.compile(r'^(?:images?|cache|caches|saves?|config|settings|user-data|userdata|backups?|runtime)(?:\.|$)', re.I)
RESERVED = re.compile(r'^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)', re.I)
TOKEN = re.compile(r'''"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|//[^\r\n]*|/\*[\s\S]*?\*/''')
FAMILY = r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def safe_component(name):
    return (name and not name.startswith('.') and not name.endswith(('.', ' '))
            and not re.search(r'[\\<>:"|?*\x00-\x1f\x7f]', name)
            and not MUTABLE.match(name) and not RESERVED.match(name))


def regular(path, directory=False):
    info = path.lstat()
    require(not path.is_symlink() and not (getattr(info, 'st_file_attributes', 0) & 0x400), f'Links/reparse points are unsupported: {path}')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), f'Not a regular {"directory" if directory else "file"}: {path}')
    return info


def valid_game_requirement(value):
    if not value or len(value) > 256:
        return False
    value = value.strip()
    if value == '*':
        return True
    families = set()
    for token in value.split():
        if token == 'wayward':
            families.add(token)
            continue
        day = re.fullmatch(r'(?:>=|<=|>|<|=)?([0-9]{4}-[0-9]{2}-[0-9]{2})(?:-[a-z][a-z0-9.]*)?', token)
        if day:
            if int(day[1][:4]) < 1000 or len(token.lstrip('<>=')) > 64:
                return False
            try:
                date.fromisoformat(day[1])
            except ValueError:
                return False
            families.add('wayward')
            continue
        variant = re.fullmatch('(' + FAMILY + r')(?:>=|<=|>|<|=)-?([0-9]+(?:\.[0-9]+)*)', token) or re.fullmatch(r'(?:>=|<=|>|<|=)?(' + FAMILY + r')-([0-9]+(?:\.[0-9]+)*)', token)
        if variant:
            if variant[1] in ('wayward', 'any') or len(variant[1] + '-' + variant[2]) > 64 or not all(re.fullmatch(r'0|[1-9][0-9]{0,5}', part) for part in variant[2].split('.')):
                return False
            families.add(variant[1])
        elif token != 'any' and len(token) <= 64 and re.fullmatch(FAMILY, token):
            families.add(token)
        else:
            return False
    return len(families) == 1


def check_header(data, mod_id, version):
    text = data.decode('utf-8-sig')[:12000]
    text = TOKEN.sub(lambda m: ' ' if m[0].startswith(('//', '/*')) else m[0], text)
    require(re.match(r'\s*WML\s*\.\s*define\s*\(\s*\{', text), 'mod.js must begin with WML.define({ (comments allowed).')
    # shortcut: this checks simple literal metadata only; the extension performs final header validation.
    header = re.split(r'''(?:^|[,\n])\s*(?:async\s+setup|symbols|setup|"symbols"|"setup"|'symbols'|'setup')\s*[:(]''', text, maxsplit=1)[0]
    for key, expected in [('id', mod_id), ('version', version), ('game', None)]:
        matches = re.findall(r'''(?:^|[{,\n])\s*(?:''' + key + '|"' + key + '"|\'' + key + r'''')\s*:\s*(['"])([^'"\\\r\n]*)\1\s*(?=[,}]|$)''', header)
        require(len(matches) == 1, f'mod.js needs one literal {key} before symbols/setup.')
        value = matches[0][1]
        require(value == expected if expected else valid_game_requirement(value), f'mod.js {key} does not match the requested package.')
    declarations = list(re.finditer(r'''(?:^|[{,\n])\s*(?:wml|"wml"|'wml')\s*:\s*''', header))
    require(len(declarations) <= 1, 'mod.js must not repeat wml metadata.')
    if declarations:
        literal = r'''(?:'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)'|"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")'''
        match = re.match(r'(?:' + literal + r'|\[\s*' + literal + r'(?:\s*,\s*' + literal + r')*\s*,?\s*\])\s*(?=[,}]|$)', header[declarations[0].end():])
        require(match, 'wml must be an exact x.y.z string or a nonempty array of exact versions.')
        versions = re.findall(r'''['"]([^'"]+)['"]''', match[0])
        require(len(versions) == len(set(versions)), 'wml versions must be unique.')
        require(all(int(part) <= 9007199254740991 for version in versions for part in version.split('.')), 'wml version component exceeds JavaScript safe integer.')


def package(source, output_dir, mod_id, version):
    require(len(mod_id) <= 64 and re.fullmatch(r'[a-z0-9][a-z0-9._-]*', mod_id)
            and not mod_id.endswith('.') and not RESERVED.match(mod_id), 'Invalid mod ID.')
    require(re.fullmatch(r'(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})', version), 'Version must be x.y.z (each component at most six digits).')
    regular(source, directory=True)
    source = source.resolve()
    output_dir = output_dir.resolve()
    require(output_dir.is_dir(), 'Output directory must already exist.')
    require(output_dir != source and source not in output_dir.parents, 'Output directory must be outside the input mod directory.')
    entries, seen, total = [], set(), 0
    def walk_error(error):
        raise error
    for folder, dirs, files in os.walk(source, followlinks=False, onerror=walk_error):
        dirs.sort()
        for name in dirs + sorted(files):
            item = Path(folder) / name
            require(safe_component(name), f'Unsafe or mutable path (nothing is silently skipped): {item}')
            info = regular(item, directory=name in dirs)
            relative = item.relative_to(source).as_posix()
            require(relative.lower() not in seen, f'Case-insensitive duplicate: {relative}')
            seen.add(relative.lower())
            if name in dirs:
                continue
            require(item.suffix[1:].lower() in EXTENSIONS, f'Unsupported file extension: {relative}')
            require(info.st_size <= 16 * 1024 * 1024, f'File exceeds 16 MiB: {relative}')
            data = item.read_bytes()
            require(len(data) == info.st_size, f'File changed while reading: {relative}')
            total += len(data)
            require(total <= 512 * 1024 * 1024 and len(entries) < 4096, 'Package exceeds 512 MiB or 4096 files.')
            entries.append((relative, data))
    mod = next((data for name, data in entries if name == 'mod.js'), None)
    require(mod is not None, 'Input directory must contain mod.js.')
    check_header(mod, mod_id, version)
    target = output_dir / f'{mod_id} {version}.zip'
    # Exclusive creation refuses overwrites; stored entries avoid decompression-ratio rejection.
    with target.open('xb') as stream:
        try:
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
                for relative, data in sorted(entries):
                    entry = zipfile.ZipInfo(f'wml/mods/{mod_id}/{relative}', date_time=(2020, 1, 1, 0, 0, 0))
                    entry.external_attr = (stat.S_IFREG | 0o644) << 16
                    archive.writestr(entry, data)
            require(stream.tell() <= 256 * 1024 * 1024, 'Stored ZIP exceeds the 256 MiB download limit.')
        except BaseException:
            stream.close()
            target.unlink()
            raise
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input_mod_directory', type=Path)
    parser.add_argument('output_directory', type=Path, nargs='?', help='Existing directory; defaults to input directory parent.')
    parser.add_argument('--id', required=True, dest='mod_id')
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    try:
        result = package(args.input_mod_directory, args.output_directory or args.input_mod_directory.absolute().parent, args.mod_id, args.version)
    except (OSError, ValueError, UnicodeError, zipfile.LargeZipFile) as error:
        parser.exit(1, f'Package rejected: {error}\n')
    print(result)
    print('The extension performs final ZIP/header validation before installation.')


if __name__ == '__main__':
    main()
