"""Engineering task corpus with real, hidden validators (no pytest; a tiny runner executes `test_*` functions).

Each task: files (the repo shown to the model), visible tests (shown; failing at the start), hidden tests (never shown;
the external validator), and a reference solution used only for harness self-checks.
Tasks span: defect repair, root-cause investigation, constrained change, refactor, cross-file API change,
spec-driven implementation, security fix, deterministic-clock logic, migration, test generation, debugging."""

TASKS = []


def task(**kw):
    TASKS.append(kw)


# ----------------------------------------------------------------------------------------------- T01
task(
    id="T01-pagination", discipline="defect_repair",
    instruction=("Users report that page 1 of the user list comes back empty and the page count is wrong. Fix the bug(s) so `list_users` "
                 "returns correct 1-based pages and an accurate page count. A `page` or `per_page` below 1 must raise ValueError."),
    files={
        "paginator.py": '''def paginate(items, page, per_page):
    """Return the items on 1-based `page`. Pages past the end return []."""
    start = page * per_page
    return items[start:start + per_page]


def page_count(total, per_page):
    return total // per_page
''',
        "api.py": '''from paginator import paginate, page_count


def list_users(users, page=1, per_page=10):
    return {"items": paginate(users, page, per_page), "pages": page_count(len(users), per_page), "page": page}
''',
    },
    visible={"tests/test_api.py": '''from api import list_users


def test_first_page():
    r = list_users(["a", "b", "c", "d", "e"], page=1, per_page=2)
    assert r["items"] == ["a", "b"], r
    assert r["pages"] == 3, r
'''},
    hidden={"hidden/test_pagination.py": '''from api import list_users


def test_last_partial_page():
    assert list_users(list("abcde"), 3, 2)["items"] == ["e"]


def test_past_the_end_is_empty():
    assert list_users(list("abcde"), 4, 2)["items"] == []


def test_exact_division():
    assert list_users(list("abcdef"), 1, 2)["pages"] == 3
    assert list_users(list("abcdef"), 3, 2)["items"] == ["e", "f"]


def test_empty_list_has_zero_pages():
    r = list_users([], 1, 10)
    assert r["items"] == [] and r["pages"] == 0


def test_invalid_arguments_raise():
    for page, per in [(0, 2), (-1, 2), (1, 0), (1, -3)]:
        try:
            list_users(list("abc"), page, per)
        except ValueError:
            continue
        raise AssertionError(("no ValueError", page, per))


def test_single_page():
    assert list_users(list("a"), 1, 10)["pages"] == 1
    assert list_users(list("a" * 10), 1, 10)["pages"] == 1
    assert list_users(list("a" * 11), 1, 10)["pages"] == 2
'''},
    reference={
        "paginator.py": '''def paginate(items, page, per_page):
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page must be >= 1")
    start = (page - 1) * per_page
    return items[start:start + per_page]


def page_count(total, per_page):
    if per_page < 1:
        raise ValueError("per_page must be >= 1")
    return -(-total // per_page)
'''},
)

# ----------------------------------------------------------------------------------------------- T02
task(
    id="T02-money", discipline="defect_repair",
    instruction=("Invoice totals are off by a cent in some cases (for example `Money(\"1.15\").cents()` returns 114). Make all monetary "
                 "arithmetic exact. Amounts are dollars with at most two decimals; the tax in `apply_tax` is rounded half up to the cent."),
    files={
        "money.py": '''class Money:
    def __init__(self, amount):
        self.amount = float(amount)

    def __add__(self, other):
        return Money(self.amount + other.amount)

    def __mul__(self, qty):
        return Money(self.amount * qty)

    def __eq__(self, other):
        return self.amount == other.amount

    def __repr__(self):
        return f"Money({self.amount:.2f})"

    def cents(self):
        return int(self.amount * 100)
''',
        "invoice.py": '''from money import Money


def invoice_total(lines):
    """lines: list of (unit_price_str, quantity)."""
    total = Money("0")
    for price, qty in lines:
        total = total + Money(price) * qty
    return total


def apply_tax(total, rate):
    """rate is a string like "0.0825"; the tax is rounded half up to the cent."""
    return Money(total.amount * (1 + float(rate)))
''',
    },
    visible={"tests/test_money.py": '''from money import Money


def test_cents_exact():
    assert Money("1.15").cents() == 115
'''},
    hidden={"hidden/test_money_hidden.py": '''from money import Money
from invoice import invoice_total, apply_tax


def test_cents_exact_many():
    for dollars in ["1.15", "0.07", "2.30", "19.99", "4.35", "8.20", "1.005".replace("1.005", "1.01")]:
        d, c = dollars.split(".")
        assert Money(dollars).cents() == int(d) * 100 + int(c.ljust(2, "0")), dollars


def test_sum_of_tenths_is_exact():
    total = invoice_total([("0.10", 1)] * 10)
    assert total.cents() == 100 and total == Money("1.00")


def test_quantity_multiplication_exact():
    assert invoice_total([("19.99", 3)]).cents() == 5997
    assert invoice_total([("1.15", 7)]).cents() == 805


def test_tax_half_up():
    assert apply_tax(Money("10.00"), "0.0825").cents() == 1083      # 10.825 -> 10.83
    assert apply_tax(Money("0.50"), "0.10").cents() == 55
    assert apply_tax(Money("1.05"), "0.10").cents() == 116          # 1.155 -> 1.16 (half up)


def test_equality_and_repr():
    assert Money("2.50") == Money("2.5")
    assert repr(Money("2.5")) == "Money(2.50)"
'''},
    reference={
        "money.py": '''from decimal import Decimal, ROUND_HALF_UP

_CENT = Decimal("0.01")


class Money:
    def __init__(self, amount):
        self.amount = Decimal(str(amount)).quantize(_CENT, rounding=ROUND_HALF_UP)

    def __add__(self, other):
        return Money(self.amount + other.amount)

    def __mul__(self, qty):
        return Money(self.amount * Decimal(qty))

    def __eq__(self, other):
        return self.amount == other.amount

    def __repr__(self):
        return f"Money({self.amount:.2f})"

    def cents(self):
        return int((self.amount * 100).to_integral_value())
''',
        "invoice.py": '''from decimal import Decimal
from money import Money


def invoice_total(lines):
    total = Money("0")
    for price, qty in lines:
        total = total + Money(price) * qty
    return total


def apply_tax(total, rate):
    return Money(total.amount * (1 + Decimal(rate)))
'''},
)

# ----------------------------------------------------------------------------------------------- T03
task(
    id="T03-cache-collision", discipline="root_cause_investigation",
    instruction=("`item_views` returns the wrong count for some users: for example user 12 / item 3 returns the count for user 1 / item 23. "
                 "Find and fix the root cause (it may not be in the file that shows the symptom)."),
    files={
        "cache.py": '''class Cache:
    def __init__(self):
        self._d = {}

    def key(self, *parts):
        return "".join(str(p) for p in parts)

    def get_or_compute(self, parts, fn):
        k = self.key(*parts)
        if k not in self._d:
            self._d[k] = fn()
        return self._d[k]
''',
        "report.py": '''from cache import Cache

_cache = Cache()


def item_views(views, user_id, item_id):
    """views: list of dicts with user_id, item_id."""
    return _cache.get_or_compute(
        (user_id, item_id),
        lambda: sum(1 for v in views if v["user_id"] == user_id and v["item_id"] == item_id),
    )
''',
    },
    visible={"tests/test_report.py": '''import report


def test_distinct_users_do_not_collide():
    report._cache = report.Cache()
    views = [{"user_id": 1, "item_id": 23}] * 5 + [{"user_id": 12, "item_id": 3}] * 2
    assert report.item_views(views, 1, 23) == 5
    assert report.item_views(views, 12, 3) == 2
'''},
    hidden={"hidden/test_cache_hidden.py": '''from cache import Cache


def test_numeric_parts_do_not_collide():
    c = Cache()
    assert c.get_or_compute((1, 23), lambda: "a") == "a"
    assert c.get_or_compute((12, 3), lambda: "b") == "b"
    assert c.get_or_compute((123,), lambda: "c") == "c"


def test_separator_in_parts():
    c = Cache()
    assert c.get_or_compute(("a|b", "c"), lambda: 1) == 1
    assert c.get_or_compute(("a", "b|c"), lambda: 2) == 2
    assert c.get_or_compute(("a,b", "c"), lambda: 3) == 3
    assert c.get_or_compute(("a", "b,c"), lambda: 4) == 4


def test_none_and_empty():
    c = Cache()
    assert c.get_or_compute(("", "ab"), lambda: 3) == 3
    assert c.get_or_compute(("ab", ""), lambda: 6) == 6
    assert c.get_or_compute(("a", "b"), lambda: 4) == 4


def test_cache_hit_does_not_recompute():
    c = Cache(); calls = []
    c.get_or_compute((1, 2), lambda: calls.append(1) or "v")
    c.get_or_compute((1, 2), lambda: calls.append(1) or "v")
    assert len(calls) == 1
'''},
    reference={
        "cache.py": '''class Cache:
    def __init__(self):
        self._d = {}

    def key(self, *parts):
        return tuple((type(p).__name__, p) for p in parts)

    def get_or_compute(self, parts, fn):
        k = self.key(*parts)
        if k not in self._d:
            self._d[k] = fn()
        return self._d[k]
'''},
)

# ----------------------------------------------------------------------------------------------- T04
task(
    id="T04-dry-run", discipline="constrained_change",
    instruction=("Add a dry-run mode and an optional prune switch without changing any existing behaviour:\n"
                 "1. `apply(actions, state, log, dry_run=False)`: when `dry_run` is true it must NOT modify `state`; each log line is then "
                 "prefixed with `[dry-run] ` (e.g. `[dry-run] create web 1.2`). It still returns `state`.\n"
                 "2. `plan(services, current, prune=True)`: when `prune` is false, services that exist only in `current` produce no `delete` action.\n"
                 "Everything else (ordering, log format, return values) must stay exactly as it is."),
    files={
        "deploy.py": '''def plan(services, current):
    """Return the actions that bring `current` (name -> version) to `services` (name -> version)."""
    actions = []
    for name, version in sorted(services.items()):
        if name not in current:
            actions.append(("create", name, version))
        elif current[name] != version:
            actions.append(("update", name, version))
    for name in sorted(current):
        if name not in services:
            actions.append(("delete", name, current[name]))
    return actions


def apply(actions, state, log):
    for kind, name, version in actions:
        if kind == "delete":
            state.pop(name, None)
        else:
            state[name] = version
        log.append(f"{kind} {name} {version}")
    return state
''',
    },
    visible={"tests/test_deploy.py": '''from deploy import plan, apply


def test_dry_run_leaves_state_untouched():
    state = {"web": "1.0"}
    log = []
    apply([("update", "web", "1.1")], state, log, dry_run=True)
    assert state == {"web": "1.0"}
    assert log == ["[dry-run] update web 1.1"]
'''},
    hidden={"hidden/test_deploy_hidden.py": '''from deploy import plan, apply


def test_existing_behaviour_unchanged():
    current = {"a": "1", "b": "1", "z": "9"}
    services = {"a": "1", "b": "2", "c": "1"}
    assert plan(services, current) == [("update", "b", "2"), ("create", "c", "1"), ("delete", "z", "9")]
    state = dict(current); log = []
    out = apply(plan(services, current), state, log)
    assert out is state and state == {"a": "1", "b": "2", "c": "1"}
    assert log == ["update b 2", "create c 1", "delete z 9"]


def test_prune_false_skips_deletes_only():
    assert plan({"a": "2"}, {"a": "1", "x": "1"}, prune=False) == [("update", "a", "2")]
    assert plan({"a": "2"}, {"a": "1", "x": "1"}, prune=True) == [("update", "a", "2"), ("delete", "x", "1")]
    assert plan({"a": "2"}, {"a": "1", "x": "1"}) == plan({"a": "2"}, {"a": "1", "x": "1"}, prune=True)


def test_dry_run_returns_same_object_and_logs_every_action():
    state = {"a": "1", "z": "9"}; log = []
    out = apply([("create", "c", "1"), ("delete", "z", "9")], state, log, dry_run=True)
    assert out is state and state == {"a": "1", "z": "9"}
    assert log == ["[dry-run] create c 1", "[dry-run] delete z 9"]


def test_non_dry_run_explicit_false():
    state = {}; log = []
    apply([("create", "c", "1")], state, log, dry_run=False)
    assert state == {"c": "1"} and log == ["create c 1"]
'''},
    reference={
        "deploy.py": '''def plan(services, current, prune=True):
    actions = []
    for name, version in sorted(services.items()):
        if name not in current:
            actions.append(("create", name, version))
        elif current[name] != version:
            actions.append(("update", name, version))
    if prune:
        for name in sorted(current):
            if name not in services:
                actions.append(("delete", name, current[name]))
    return actions


def apply(actions, state, log, dry_run=False):
    prefix = "[dry-run] " if dry_run else ""
    for kind, name, version in actions:
        if not dry_run:
            if kind == "delete":
                state.pop(name, None)
            else:
                state[name] = version
        log.append(f"{prefix}{kind} {name} {version}")
    return state
'''},
)

# ----------------------------------------------------------------------------------------------- T05
task(
    id="T05-iterative-tree", discipline="refactor",
    instruction=("`flatten` and `depth` crash with RecursionError on very deep trees (for example a chain of 5000 nodes). Rewrite them "
                 "iteratively so they work for any depth, without changing results: `flatten` is a pre-order traversal visiting children "
                 "left to right; `depth` is the number of nodes on the longest root-to-leaf path."),
    files={
        "tree.py": '''class Node:
    def __init__(self, value, children=None):
        self.value = value
        self.children = children or []


def flatten(node):
    out = [node.value]
    for child in node.children:
        out.extend(flatten(child))
    return out


def depth(node):
    return 1 + max((depth(c) for c in node.children), default=0)
''',
    },
    visible={"tests/test_tree.py": '''from tree import Node, flatten, depth


def test_deep_chain():
    root = Node(0)
    cur = root
    for i in range(1, 5000):
        nxt = Node(i)
        cur.children.append(nxt)
        cur = nxt
    assert flatten(root) == list(range(5000))
    assert depth(root) == 5000
'''},
    hidden={"hidden/test_tree_hidden.py": '''from tree import Node, flatten, depth


def chain(n):
    root = Node(0); cur = root
    for i in range(1, n):
        nxt = Node(i); cur.children.append(nxt); cur = nxt
    return root


def test_very_deep_chain():
    root = chain(60000)
    assert depth(root) == 60000
    assert flatten(root)[-1] == 59999


def test_preorder_left_to_right():
    t = Node("r", [Node("a", [Node("a1"), Node("a2")]), Node("b"), Node("c", [Node("c1", [Node("c11")])])])
    assert flatten(t) == ["r", "a", "a1", "a2", "b", "c", "c1", "c11"]
    assert depth(t) == 4


def test_single_node_and_wide():
    assert flatten(Node(1)) == [1] and depth(Node(1)) == 1
    wide = Node("r", [Node(i) for i in range(1000)])
    assert flatten(wide) == ["r"] + list(range(1000)) and depth(wide) == 2


def test_no_recursion_used():
    import sys
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(60)
    try:
        assert flatten(chain(2000))[-1] == 1999 and depth(chain(2000)) == 2000
    finally:
        sys.setrecursionlimit(limit)
'''},
    reference={
        "tree.py": '''class Node:
    def __init__(self, value, children=None):
        self.value = value
        self.children = children or []


def flatten(node):
    out = []
    stack = [node]
    while stack:
        n = stack.pop()
        out.append(n.value)
        stack.extend(reversed(n.children))
    return out


def depth(node):
    best = 0
    stack = [(node, 1)]
    while stack:
        n, d = stack.pop()
        best = max(best, d)
        for c in n.children:
            stack.append((c, d + 1))
    return best
'''},
)

# ----------------------------------------------------------------------------------------------- T06
task(
    id="T06-api-rename", discipline="cross_file_change",
    instruction=("Change `fetch` in http_client.py so its second parameter is named `timeout_s`, is keyword-only, and defaults to 5. "
                 "Update every caller so each one keeps exactly the timeout it uses today."),
    files={
        "http_client.py": '''def fetch(url, timeout=5):
    return {"url": url, "timeout": timeout, "status": 200}
''',
        "users.py": '''from http_client import fetch


def load_user(uid):
    return fetch(f"/users/{uid}", 3)
''',
        "orders.py": '''from http_client import fetch


def load_order(oid):
    return fetch(f"/orders/{oid}", timeout=10)
''',
        "health.py": '''from http_client import fetch


def ping():
    return fetch("/health")
''',
    },
    visible={"tests/test_http.py": '''from http_client import fetch


def test_new_parameter_name():
    assert fetch("/a", timeout_s=2)["timeout"] == 2
'''},
    hidden={"hidden/test_http_hidden.py": '''from http_client import fetch
import users, orders, health


def test_default_and_keyword_only():
    assert fetch("/x")["timeout"] == 5
    for bad in (lambda: fetch("/x", 3), lambda: fetch("/x", timeout=3)):
        try:
            bad()
        except TypeError:
            continue
        raise AssertionError("positional or old-name timeout must be rejected")


def test_callers_keep_their_timeouts():
    assert users.load_user(7)["timeout"] == 3 and users.load_user(7)["url"] == "/users/7"
    assert orders.load_order(9)["timeout"] == 10 and orders.load_order(9)["url"] == "/orders/9"
    assert health.ping()["timeout"] == 5 and health.ping()["url"] == "/health"
'''},
    reference={
        "http_client.py": '''def fetch(url, *, timeout_s=5):
    return {"url": url, "timeout": timeout_s, "status": 200}
''',
        "users.py": '''from http_client import fetch


def load_user(uid):
    return fetch(f"/users/{uid}", timeout_s=3)
''',
        "orders.py": '''from http_client import fetch


def load_order(oid):
    return fetch(f"/orders/{oid}", timeout_s=10)
'''},
)

# ----------------------------------------------------------------------------------------------- T07
task(
    id="T07-parse-duration", discipline="spec_implementation",
    instruction="Implement `parse_duration` exactly as its docstring specifies.",
    files={
        "durations.py": '''def parse_duration(text):
    """Parse a human-readable duration into whole seconds (int).

    Grammar: one or more `<integer><unit>` groups, units d, h, m, s (case-insensitive), groups optionally
    separated by exactly one space. Examples: "1h30m" -> 5400, "2d" -> 172800, "45s" -> 45, "1H 30M" -> 5400.
    Leading and trailing whitespace is ignored. Leading zeros are fine ("01h" -> 3600) and "0s" -> 0.
    Units must appear at most once and in descending order (d, h, m, s).
    A bare integer with no unit, an empty or whitespace-only string, an unknown unit, a negative or decimal
    number, two or more spaces between groups, or a space between a number and its unit all raise ValueError.
    """
    raise NotImplementedError
''',
    },
    visible={"tests/test_durations.py": '''from durations import parse_duration


def test_basic():
    assert parse_duration("1h30m") == 5400
    assert parse_duration("2d") == 172800
    assert parse_duration("45s") == 45
'''},
    hidden={"hidden/test_durations_hidden.py": '''from durations import parse_duration


def raises(text):
    try:
        parse_duration(text)
    except ValueError:
        return True
    return False


def test_valid_forms():
    assert parse_duration("1H 30M") == 5400
    assert parse_duration("1d2h3m4s") == 93784
    assert parse_duration("  10m  ") == 600
    assert parse_duration("01h") == 3600 and parse_duration("0s") == 0
    assert parse_duration("1d 1s") == 86401
    assert isinstance(parse_duration("5m"), int)


def test_invalid_forms():
    for bad in ["90", "", "   ", "1x", "-1s", "1.5h", "1h  30m", "1 h", "30m1h", "1h1h", "1s1m", "h", "1h30", "1h,30m", "1h30m "[:0] + "m1"]:
        assert raises(bad), bad


def test_order_and_duplicates():
    assert raises("1m2h") and raises("1d1d") and raises("2s1d")
    assert parse_duration("1d1h1m1s") == 90061
'''},
    reference={
        "durations.py": '''import re

_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
_GROUP = re.compile(r"(\\d+)([dhmsDHMS])")


def parse_duration(text):
    s = text.strip()
    if not s:
        raise ValueError("empty duration")
    pos = 0
    total = 0
    last_rank = -1
    order = "dhms"
    first = True
    while pos < len(s):
        if not first:
            if s[pos] != " ":
                pass
            elif pos + 1 < len(s) and s[pos + 1] == " ":
                raise ValueError("multiple spaces")
            else:
                pos += 1
        m = _GROUP.match(s, pos)
        if not m:
            raise ValueError("bad group")
        unit = m.group(2).lower()
        rank = order.index(unit)
        if rank <= last_rank:
            raise ValueError("unit order")
        last_rank = rank
        total += int(m.group(1)) * _UNITS[unit]
        pos = m.end()
        first = False
    return total
'''},
)

# ----------------------------------------------------------------------------------------------- T08
task(
    id="T08-safe-join", discipline="security_fix",
    instruction=("`safe_join(base, user_path)` is used to open user-supplied file names under `base`, but it allows path traversal. Make it "
                 "fail closed: it must return the absolute resolved path only if that path is inside `base`, otherwise raise ValueError. "
                 "Requirements: percent-decode `user_path` once before checking (so `%2e%2e%2f` is a traversal); treat both `/` and `\\\\` as "
                 "separators; reject absolute paths, `..` that escapes `base`, NUL bytes, and any path that resolves (following symlinks) "
                 "outside `base`. A path that stays inside `base`, including one using `..` that remains inside, is fine."),
    files={
        "storage.py": '''import os


def safe_join(base, user_path):
    return os.path.join(base, user_path)
''',
        "uploads.py": '''from storage import safe_join


def read_upload(base, name):
    with open(safe_join(base, name), "rb") as fh:
        return fh.read()
''',
    },
    visible={"tests/test_storage.py": '''import os
import tempfile
from storage import safe_join


def test_rejects_parent_traversal():
    base = tempfile.mkdtemp()
    try:
        safe_join(base, "../etc/passwd")
    except ValueError:
        return
    raise AssertionError("traversal accepted")
'''},
    hidden={"hidden/test_storage_hidden.py": '''import os
import tempfile
from storage import safe_join


def rejects(base, p):
    try:
        safe_join(base, p)
    except ValueError:
        return True
    return False


def test_traversal_variants_rejected():
    base = tempfile.mkdtemp()
    for p in ["../x", "a/../../x", "..", "/etc/passwd", "%2e%2e/x", "%2e%2e%2fx", "a%2f..%2f..%2fx", "..\\\\x", "a\\\\..\\\\..\\\\x", "ok\\x00.txt", "%00"]:
        assert rejects(base, p), p


def test_inside_paths_allowed_and_absolute_result():
    base = tempfile.mkdtemp()
    r = safe_join(base, "a/b.txt")
    assert os.path.isabs(r) and r.startswith(os.path.realpath(base)) and r.endswith("a/b.txt")
    assert safe_join(base, "a/../b.txt").endswith("/b.txt")
    assert safe_join(base, "dir%2ffile.txt").endswith("dir/file.txt")
    assert os.path.realpath(safe_join(base, "")) == os.path.realpath(base)


def test_symlink_escape_rejected():
    base = tempfile.mkdtemp(); outside = tempfile.mkdtemp()
    os.symlink(outside, os.path.join(base, "link"))
    open(os.path.join(outside, "secret"), "w").write("x")
    assert rejects(base, "link/secret") and rejects(base, "link")


def test_symlink_inside_allowed():
    base = tempfile.mkdtemp()
    os.mkdir(os.path.join(base, "real"))
    os.symlink(os.path.join(base, "real"), os.path.join(base, "alias"))
    assert safe_join(base, "alias/f.txt").endswith("real/f.txt")


def test_prefix_confusion():
    parent = tempfile.mkdtemp()
    base = os.path.join(parent, "data"); os.mkdir(base)
    os.mkdir(os.path.join(parent, "data2"))
    assert rejects(base, "../data2/secret")
'''},
    reference={
        "storage.py": '''import os
from urllib.parse import unquote


def safe_join(base, user_path):
    decoded = unquote(user_path)
    if "\\x00" in decoded:
        raise ValueError("NUL byte")
    decoded = decoded.replace("\\\\", "/")
    if decoded.startswith("/"):
        raise ValueError("absolute path")
    root = os.path.realpath(base)
    target = os.path.realpath(os.path.join(root, decoded))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("path escapes base")
    return target
'''},
)

# ----------------------------------------------------------------------------------------------- T09
task(
    id="T09-token-bucket", discipline="defect_repair",
    instruction=("`TokenBucket` lets bursts through that exceed its capacity after an idle period. Fix it: the token count must never exceed "
                 "`capacity`; refill is `rate` tokens per second of the injected clock; `allow(cost)` consumes `cost` tokens only when enough are "
                 "available, and a `cost` larger than `capacity` must always be refused without consuming anything."),
    files={
        "ratelimit.py": '''class TokenBucket:
    def __init__(self, rate, capacity, clock):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock
        self.tokens = capacity
        self.last = clock()

    def allow(self, cost=1):
        now = self.clock()
        self.tokens += (now - self.last) * self.rate
        self.last = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False
''',
    },
    visible={"tests/test_ratelimit.py": '''from ratelimit import TokenBucket


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_no_burst_beyond_capacity_after_idle():
    clk = Clock()
    b = TokenBucket(rate=1, capacity=3, clock=clk)
    for _ in range(3):
        assert b.allow()
    clk.t += 100
    allowed = sum(1 for _ in range(10) if b.allow())
    assert allowed == 3, allowed
'''},
    hidden={"hidden/test_ratelimit_hidden.py": '''from ratelimit import TokenBucket


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_fractional_refill():
    clk = Clock(); b = TokenBucket(rate=2, capacity=4, clock=clk)
    assert b.allow(4) and not b.allow()
    clk.t += 0.25
    assert not b.allow()          # 0.5 tokens
    clk.t += 0.25
    assert b.allow() and not b.allow()


def test_cost_larger_than_capacity_never_consumes():
    clk = Clock(); b = TokenBucket(rate=1, capacity=3, clock=clk)
    assert not b.allow(5) and not b.allow(4)
    assert b.allow(3)


def test_capacity_cap_with_partial_costs():
    clk = Clock(); b = TokenBucket(rate=10, capacity=5, clock=clk)
    clk.t += 1000
    assert b.allow(2) and b.allow(3) and not b.allow(1)


def test_zero_rate_never_refills():
    clk = Clock(); b = TokenBucket(rate=0, capacity=2, clock=clk)
    assert b.allow() and b.allow() and not b.allow()
    clk.t += 1000
    assert not b.allow()


def test_refusal_does_not_consume():
    clk = Clock(); b = TokenBucket(rate=1, capacity=3, clock=clk)
    assert b.allow(2) and not b.allow(2)
    assert b.allow(1)
'''},
    reference={
        "ratelimit.py": '''class TokenBucket:
    def __init__(self, rate, capacity, clock):
        self.rate = rate
        self.capacity = capacity
        self.clock = clock
        self.tokens = capacity
        self.last = clock()

    def allow(self, cost=1):
        now = self.clock()
        self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if cost > self.capacity:
            return False
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False
'''},
)

# ----------------------------------------------------------------------------------------------- T10 (migration)
task(
    id="T10-sqlite-migration", discipline="data_migration",
    instruction=("Implement `migrate(conn)` in db.py to upgrade a version-1 database to version 2: add a nullable TEXT column "
                 "`email_domain` to `users` and backfill it with the lower-cased part of `email` after its last `@` (NULL when email is NULL or "
                 "contains no `@`); then set the single row in `schema_version` to 2. It must be idempotent (running it on a v2 database changes "
                 "nothing and does not fail), must not lose or alter any other data, and must leave exactly one row in `schema_version`."),
    files={
        "db.py": '''import sqlite3


def init_v1(conn):
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)")
    conn.execute("CREATE TABLE schema_version (version INTEGER)")
    conn.execute("INSERT INTO schema_version VALUES (1)")
    conn.commit()


def version(conn):
    return conn.execute("SELECT version FROM schema_version").fetchone()[0]


def migrate(conn):
    raise NotImplementedError
''',
    },
    visible={"tests/test_db.py": '''import sqlite3
import db


def test_basic_migration():
    conn = sqlite3.connect(":memory:")
    db.init_v1(conn)
    conn.execute("INSERT INTO users (name, email) VALUES ('a', 'A@Example.COM')")
    db.migrate(conn)
    assert db.version(conn) == 2
    assert conn.execute("SELECT email_domain FROM users").fetchone()[0] == "example.com"
'''},
    hidden={"hidden/test_db_hidden.py": '''import sqlite3
import db


def fresh():
    conn = sqlite3.connect(":memory:")
    db.init_v1(conn)
    return conn


def test_backfill_edge_cases():
    conn = fresh()
    rows = [("a", "u@Foo.Org"), ("b", None), ("c", "no-at-sign"), ("d", "x@y@Bar.NET"), ("e", ""), ("f", "z@")]
    conn.executemany("INSERT INTO users (name, email) VALUES (?, ?)", rows)
    db.migrate(conn)
    got = dict(conn.execute("SELECT name, email_domain FROM users").fetchall())
    assert got == {"a": "foo.org", "b": None, "c": None, "d": "bar.net", "e": None, "f": ""}, got


def test_other_data_untouched_and_idempotent():
    conn = fresh()
    conn.execute("INSERT INTO users (id, name, email) VALUES (7, 'n', 'q@w.com')")
    db.migrate(conn)
    before = conn.execute("SELECT id, name, email, email_domain FROM users ORDER BY id").fetchall()
    db.migrate(conn)
    after = conn.execute("SELECT id, name, email, email_domain FROM users ORDER BY id").fetchall()
    assert before == after == [(7, "n", "q@w.com", "w.com")]
    assert db.version(conn) == 2
    assert conn.execute("SELECT COUNT(*) FROM schema_version").fetchone()[0] == 1


def test_column_is_added_once_and_empty_table_ok():
    conn = fresh()
    db.migrate(conn); db.migrate(conn)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    assert cols.count("email_domain") == 1 and cols[:3] == ["id", "name", "email"]
'''},
    reference={
        "db.py": '''import sqlite3


def init_v1(conn):
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)")
    conn.execute("CREATE TABLE schema_version (version INTEGER)")
    conn.execute("INSERT INTO schema_version VALUES (1)")
    conn.commit()


def version(conn):
    return conn.execute("SELECT version FROM schema_version").fetchone()[0]


def migrate(conn):
    if version(conn) >= 2:
        return
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "email_domain" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN email_domain TEXT")
    for uid, email in conn.execute("SELECT id, email FROM users").fetchall():
        domain = None
        if email is not None and "@" in email:
            domain = email.rsplit("@", 1)[1].lower()
        conn.execute("UPDATE users SET email_domain = ? WHERE id = ?", (domain, uid))
    conn.execute("UPDATE schema_version SET version = 2")
    conn.commit()
'''},
)

# ----------------------------------------------------------------------------------------------- T11 (test generation, mutation validated)
LRU_REF = '''class LRUCache:
    """Least-recently-used cache. `get` returns None on a miss and marks a hit as most recently used.
    `put` inserts or updates a key (and marks it most recently used); when the size would exceed `capacity`
    the least recently used key is evicted. `len(cache)` is the number of stored keys."""

    def __init__(self, capacity):
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self.capacity = capacity
        self._d = {}
        self._order = []

    def get(self, key):
        if key not in self._d:
            return None
        self._order.remove(key)
        self._order.append(key)
        return self._d[key]

    def put(self, key, value):
        if key in self._d:
            self._order.remove(key)
        self._d[key] = value
        self._order.append(key)
        if len(self._d) > self.capacity:
            oldest = self._order.pop(0)
            del self._d[oldest]

    def __len__(self):
        return len(self._d)
'''
LRU_MUTANTS = {
    "get-no-recency": LRU_REF.replace("        self._order.remove(key)\n        self._order.append(key)\n        return self._d[key]", "        return self._d[key]"),
    "evict-newest": LRU_REF.replace("oldest = self._order.pop(0)", "oldest = self._order.pop()"),
    "capacity-off-by-one": LRU_REF.replace("len(self._d) > self.capacity", "len(self._d) > self.capacity + 1"),
    "put-no-update": LRU_REF.replace("        if key in self._d:\n            self._order.remove(key)\n        self._d[key] = value", "        if key in self._d:\n            self._order.remove(key)\n            self._order.append(key)\n            return\n        self._d[key] = value"),
    "no-capacity-validation": LRU_REF.replace('        if capacity < 1:\n            raise ValueError("capacity must be >= 1")\n', ""),
}
LRU_REFERENCE_TESTS = '''from lru import LRUCache


def test_miss_returns_none():
    c = LRUCache(2)
    assert c.get("x") is None


def test_put_get_and_len():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert c.get("a") == 1 and c.get("b") == 2 and len(c) == 2


def test_evicts_least_recently_used():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2); c.put("c", 3)
    assert c.get("a") is None and c.get("b") == 2 and c.get("c") == 3 and len(c) == 2


def test_get_refreshes_recency():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert c.get("a") == 1
    c.put("c", 3)
    assert c.get("b") is None and c.get("a") == 1


def test_put_existing_updates_value_and_recency():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    c.put("a", 10)
    c.put("c", 3)
    assert c.get("a") == 10 and c.get("b") is None and len(c) == 2


def test_capacity_exact():
    c = LRUCache(3)
    for i in range(3):
        c.put(i, i)
    assert len(c) == 3 and all(c.get(i) == i for i in range(3))


def test_invalid_capacity():
    for bad in (0, -1):
        try:
            LRUCache(bad)
        except ValueError:
            continue
        raise AssertionError("capacity must be validated")
'''
task(
    id="T11-test-generation", discipline="test_generation", mutation=True, deliverable="tests/test_lru.py",
    instruction=("Write a thorough test suite for `LRUCache` in the file `tests/test_lru.py` (plain functions named `test_*` using `assert`; "
                 "import with `from lru import LRUCache`). Your tests must all pass on the correct implementation and must detect "
                 "behaviour changes: they are later run against deliberately broken variants of the class and should fail on each one. "
                 "Cover every behaviour described in the class docstring and its edge cases."),
    files={"lru.py": LRU_REF},
    visible={},
    hidden={},
    reference={"tests/test_lru.py": LRU_REFERENCE_TESTS},
    mutants=LRU_MUTANTS,
)

# ----------------------------------------------------------------------------------------------- T12 (debugging from a traceback)
task(
    id="T12-nested-config", discipline="debugging",
    instruction=("Production raised the traceback below. Fix `get_path` so it behaves as its docstring says, and make sure `settings.py` keeps "
                 "working.\n\nTraceback (most recent call last):\n  File \"settings.py\", line 6, in port\n    return get_path(CONFIG, \"server.port\", 8080)\n"
                 "  File \"config.py\", line 9, in get_path\n    cur = cur[part]\nKeyError: 'server'"),
    files={
        "config.py": '''def get_path(cfg, path, default=None):
    """Fetch a nested value by dotted path, e.g. get_path(cfg, "db.pool.size").

    Numeric parts index into lists ("servers.0.host"). Return `default` when any part is missing, a list index
    is out of range, or an intermediate value is not a dict/list. A value that exists and is None is returned
    as None (not `default`). An empty path returns `cfg` itself. Never raises for missing data.
    """
    cur = cfg
    for part in path.split("."):
        cur = cur[part]
    return cur
''',
        "settings.py": '''from config import get_path

CONFIG = {"db": {"pool": {"size": 5}}, "servers": [{"host": "a"}, {"host": "b"}]}


def port():
    return get_path(CONFIG, "server.port", 8080)
''',
    },
    visible={"tests/test_settings.py": '''import settings


def test_port_default_when_missing():
    assert settings.port() == 8080
'''},
    hidden={"hidden/test_config_hidden.py": '''from config import get_path

CFG = {"a": {"b": {"c": 1}}, "n": None, "z": 0, "servers": [{"host": "h0"}, {"host": "h1"}], "s": "text", "f": False}


def test_found_values():
    assert get_path(CFG, "a.b.c") == 1
    assert get_path(CFG, "servers.1.host") == "h1"
    assert get_path(CFG, "z", "d") == 0 and get_path(CFG, "f", "d") is False


def test_none_is_a_value_not_missing():
    assert get_path(CFG, "n", "default") is None


def test_missing_returns_default():
    assert get_path(CFG, "a.x.c", "d") == "d"
    assert get_path(CFG, "q", "d") == "d"
    assert get_path(CFG, "q") is None


def test_list_indexing_edges():
    assert get_path(CFG, "servers.5.host", "d") == "d"
    assert get_path(CFG, "servers.x.host", "d") == "d"
    assert get_path(CFG, "servers.-1.host", "d") in ("d", "h1")
    assert get_path(CFG, "servers.0", None) == {"host": "h0"}


def test_non_container_intermediate():
    assert get_path(CFG, "s.length", "d") == "d"
    assert get_path(CFG, "a.b.c.d", "d") == "d"
    assert get_path(CFG, "z.y", "d") == "d"


def test_empty_path_returns_cfg():
    assert get_path(CFG, "") is CFG
'''},
    reference={
        "config.py": '''def get_path(cfg, path, default=None):
    if path == "":
        return cfg
    cur = cfg
    for part in path.split("."):
        if isinstance(cur, dict):
            if part not in cur:
                return default
            cur = cur[part]
        elif isinstance(cur, list):
            if not part.isdigit():
                return default
            i = int(part)
            if i >= len(cur):
                return default
            cur = cur[i]
        else:
            return default
    return cur
'''},
)
