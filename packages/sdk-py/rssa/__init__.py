"""RSS-A (RSS for Agents): publish, sign, read and verify agent feeds and groups."""

from .agent import (EXT_URI, MEDIA_TYPES, FeedRead, ReadEntry, build_feed, card_extension, card_modules, entry, find_rssa, local_filter,
                    now, ping_hub, read_feed, read_group, GroupRead, sign_card, with_rssa)
from .canonical import CanonicalError, canonicalize, strict_parse
from .feed import Entry, ParsedFeed, atom_xml, json_feed, parse_feed, rss_xml
from .keys import Key, generate_key, key_from_jwk, key_from_seed, load_key, resolve_keys, sign_detached, thumbprint, verify_detached
from .policy import CORE_TYPES, PRESETS, check_entry, effective_settings, roster_opml, sign_policy, verify_policy
from .sign import content_hash, content_hash_input, entry_payload, sign_entry, verify_entry

__version__ = "0.1.1"
