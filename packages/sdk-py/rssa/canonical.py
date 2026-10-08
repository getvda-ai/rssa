"""RSSA canonical JSON: RFC 8785 (JCS) restricted to the RSSA signable subset.

Signable values are strings, booleans, safe integers (|n| <= 2**53 - 1), None, lists and
dicts of those. No floats, no exponents, no duplicate keys, no lone surrogates. Inside that
subset JCS has exactly one correct output, so Python and JavaScript produce identical bytes.
"""

from __future__ import annotations

import json
import re
from typing import Any

MAX_SAFE = 2**53 - 1


class CanonicalError(ValueError):
    def __init__(self, code: str, message: str, path: str = "$"):
        super().__init__(f"{message} (at {path})")
        self.code = code
        self.path = path


_NUMBER = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?")


def strict_parse(text: str) -> Any:
    """Parses JSON, rejecting floats, exponents, unsafe integers, duplicate keys and lone surrogates."""

    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise CanonicalError("duplicate-key", f"duplicate key {json.dumps(k)}")
            out[k] = v
        return out

    def bad_float(s):
        raise CanonicalError("float", f"number {s} is not an integer — send amounts and measurements as strings, e.g. \"12.50\"")

    def check_int(s):
        n = int(s)
        if abs(n) > MAX_SAFE:
            raise CanonicalError("unsafe-integer", f"integer {s} is outside ±(2^53-1) — send it as a string")
        return n

    def bad_constant(s):
        raise CanonicalError("syntax", f"{s} is not JSON")

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_float=bad_float, parse_int=check_int, parse_constant=bad_constant)
    except CanonicalError:
        raise
    except json.JSONDecodeError as e:
        code = "syntax"
        raise CanonicalError(code, e.msg + f" at offset {e.pos}") from None
    _check_strings(value, "$")
    return value


def _check_strings(v: Any, path: str) -> None:
    if isinstance(v, str):
        _assert_well_formed(v, path)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            _check_strings(x, f"{path}[{i}]")
    elif isinstance(v, dict):
        for k, x in v.items():
            _assert_well_formed(k, path)
            _check_strings(x, f"{path}.{k}")


def _assert_well_formed(s: str, path: str) -> None:
    for ch in s:
        if 0xD800 <= ord(ch) <= 0xDFFF:
            raise CanonicalError("lone-surrogate", "string contains a lone surrogate", path)


_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _quote(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(k: str) -> bytes:
    # JCS sorts keys by UTF-16 code units; big-endian UTF-16 bytes compare the same way.
    return k.encode("utf-16-be")


def canonicalize(v: Any, path: str = "$") -> str:
    """Canonical JSON text of a value in the RSSA signable subset. Raises CanonicalError otherwise."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        _assert_well_formed(v, path)
        return _quote(v)
    if isinstance(v, int):
        if abs(v) > MAX_SAFE:
            raise CanonicalError("unsafe-integer", f"integer {v} is outside ±(2^53-1)", path)
        return str(v)
    if isinstance(v, float):
        raise CanonicalError("float", f"number {v} is not an integer — send it as a string", path)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonicalize(x, f"{path}[{i}]") for i, x in enumerate(v)) + "]"
    if isinstance(v, dict):
        for k in v:
            if not isinstance(k, str):
                raise CanonicalError("type", "object keys must be strings", path)
            _assert_well_formed(k, path)
        return "{" + ",".join(_quote(k) + ":" + canonicalize(v[k], f"{path}.{k}") for k in sorted(v, key=_utf16_key)) + "}"
    raise CanonicalError("type", f"type {type(v).__name__} cannot be signed", path)
