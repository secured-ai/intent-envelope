"""Version 0.2: changing an envelope, and admitting a component into an agent's toolset.

A port of the TypeScript ``amend.ts``. Both produce the same canonical bytes, list the
same widenings and reach the same verdicts, and the conformance files under
``conformance/amendments`` and ``conformance/components`` hold them to it.

Signature verification needs the ``cryptography`` package, which this distribution does
not otherwise depend on: ``pip install intent-envelope[signing]``. Without it,
``check_amendment`` refuses every signed proposal and says why, rather than accepting one
it could not check.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .evaluate import _parse_instant, default_data_matcher, host_matches

__all__ = ["canonical", "widening", "check_amendment", "sign_amendment", "admit_component", "AmendmentCheck", "Admission"]


def _num(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite numbers have no canonical form")
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def canonical(value: Any) -> str:
    """Sorted keys, no insignificant whitespace, integer-valued numbers without a decimal
    point. The same bytes the TypeScript implementation signs."""
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float)):
        return _num(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical(value[k])}" for k in sorted(value)) + "}"
    raise TypeError(f"cannot canonicalise {type(value).__name__}")


def _list(v: Any) -> List[str]:
    return [str(x) for x in v] if isinstance(v, list) else []


def _added(before: List[str], after: List[str]) -> List[str]:
    return [x for x in after if x not in before]


def _removed(before: List[str], after: List[str]) -> List[str]:
    return [x for x in before if x not in after]


def _fmt(v: Any) -> str:
    return _num(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)


def widening(current: Dict[str, Any], nxt: Dict[str, Any]) -> List[str]:
    """Every way ``nxt`` grants more than ``current``, in words for the person who signs."""
    out: List[str] = []

    def grants(e: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        return {g["name"]: (g.get("constraints") or {}) for g in ((e.get("tools") or {}).get("allow") or [])}

    before, after = grants(current), grants(nxt)
    for name, constraints in after.items():
        if name not in before:
            out.append(f"tools.allow gains {name}")
            continue
        for k, v in before[name].items():
            if k not in constraints:
                out.append(f"{name} loses its {k} constraint")
            elif k.startswith("max_") and float(constraints[k]) > float(v):
                out.append(f"{name} {k} rises from {_fmt(v)} to {_fmt(constraints[k])}")
            elif k.startswith("min_") and float(constraints[k]) < float(v):
                out.append(f"{name} {k} falls from {_fmt(v)} to {_fmt(constraints[k])}")
            elif not k.startswith(("max_", "min_")) and canonical(constraints[k]) != canonical(v):
                out.append(f"{name} {k} changes from {canonical(v)} to {canonical(constraints[k])}")
    for t in _removed(_list((current.get("tools") or {}).get("deny")), _list((nxt.get("tools") or {}).get("deny"))):
        out.append(f"tools.deny no longer refuses {t}")

    cd, nd = current.get("data"), nxt.get("data")
    if cd and not nd:
        out.append("the data block is removed, leaving data unconstrained")
    for d in _added(_list((cd or {}).get("allow")), _list((nd or {}).get("allow"))):
        out.append(f"data.allow gains {d}")
    if (cd or {}).get("allow") is not None and nd and nd.get("allow") is None:
        out.append("data.allow is removed")
    for d in _removed(_list((cd or {}).get("deny")), _list((nd or {}).get("deny"))):
        out.append(f"data.deny no longer refuses {d}")
    if (cd or {}).get("processors") is not None and (nd or {}).get("processors") is None:
        out.append("data.processors is removed, leaving processors unconstrained")
    if (cd or {}).get("processors") is not None:
        for p in _added(_list(cd.get("processors")), _list((nd or {}).get("processors"))):
            out.append(f"data.processors gains {p}")

    cr, nr = current.get("recipients"), nxt.get("recipients")
    if not cr and nr:
        out.append("recipients are permitted where none were")
    if cr:
        for r in _added(_list(cr.get("allow")), _list((nr or {}).get("allow"))):
            out.append(f"recipients.allow gains {r}")
        was = cr.get("max_per_run")
        now = (nr or {}).get("max_per_run")
        if was is not None and (now is None or now > was):
            out.append(f"recipients.max_per_run rises from {_fmt(was)} to {_fmt(now) if now is not None else 'unlimited'}")

    for k, v in (current.get("limits") or {}).items():
        n = (nxt.get("limits") or {}).get(k)
        if n is None:
            out.append(f"limits.{k} is removed")
        elif float(n) > float(v):
            out.append(f"limits.{k} rises from {_fmt(v)} to {_fmt(n)}")

    rules = lambda e: [canonical(r) for r in (e.get("escalate") or [])]  # noqa: E731
    for r in _removed(rules(current), rules(nxt)):
        out.append(f"an escalation is removed or changed: {r}")
    if current.get("on_no_response") == "deny" and nxt.get("on_no_response") == "allow":
        out.append("on_no_response changes from deny to allow")

    ce, ne = current.get("expires"), nxt.get("expires")
    if ce:
        a, b = _parse_instant(ce), _parse_instant(ne) if ne else None
        if not ne or (a is not None and b is not None and b > a):
            out.append(f"expires moves from {ce} to {ne or 'never'}")

    cg, ng = current.get("egress"), nxt.get("egress")
    if cg and not ng:
        out.append("the egress block is removed, leaving egress unconstrained")
    if cg:
        for h in _added(_list(cg.get("allow")), _list((ng or {}).get("allow"))):
            out.append(f"egress.allow gains {h}")
        if cg.get("allow") is not None and ng and ng.get("allow") is None:
            out.append("egress.allow is removed")
    for h in _removed(_list((cg or {}).get("deny")), _list((ng or {}).get("deny"))):
        out.append(f"egress.deny no longer refuses {h}")

    cc, nc = current.get("credentials"), nxt.get("credentials")
    if cc and not nc:
        out.append("the credentials block is removed")
    if (cc or {}).get("bind") == "task" and (nc or {}).get("bind") == "run":
        out.append("credentials bind to the run rather than the task")
    life, nlife = (cc or {}).get("max_lifetime_seconds"), (nc or {}).get("max_lifetime_seconds")
    if life is not None and nc and (nlife is None or nlife > life):
        out.append(f"credentials.max_lifetime_seconds rises from {_fmt(life)} to {_fmt(nlife) if nlife is not None else 'unlimited'}")

    ap = lambda e: [f"{a['id']} {a['public_key'].strip()}" for a in ((e.get("amendment") or {}).get("approvers") or [])]  # noqa: E731
    for a in _added(ap(current), ap(nxt)):
        out.append(f"amendment.approvers gains {a.split(' ')[0]}")
    for t in _removed(_list((current.get("amendment") or {}).get("protected_tools")), _list((nxt.get("amendment") or {}).get("protected_tools"))):
        out.append(f"amendment.protected_tools no longer protects {t}")
    if (current.get("components") or {}).get("require_manifest") and not (nxt.get("components") or {}).get("require_manifest"):
        out.append("components no longer need a manifest")
    return out


class AmendmentCheck:
    def __init__(self, accepted: bool, reasons: List[str], widening_: List[str], approved_by: Optional[str], record: Dict[str, Any]):
        self.accepted = accepted
        self.reasons = reasons
        self.widening = widening_
        self.approved_by = approved_by
        self._record = record

    def record(self) -> Dict[str, Any]:
        """For the ledger: refused proposals are recorded as carefully as accepted ones."""
        return dict(self._record)


def _verify(public_key_pem: str, message: bytes, signature_b64url: str) -> bool:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
    except ImportError as exc:  # pragma: no cover - exercised only without the extra
        raise RuntimeError("verifying an amendment needs the cryptography package: pip install intent-envelope[signing]") from exc
    try:
        key = load_pem_public_key(public_key_pem.encode())
        if not isinstance(key, Ed25519PublicKey):
            return False
        pad = "=" * (-len(signature_b64url) % 4)
        key.verify(base64.urlsafe_b64decode(signature_b64url + pad), message)
        return True
    except Exception:
        return False


def sign_amendment(proposed: Dict[str, Any], private_key_pem: str) -> str:
    """Sign a proposed revision with an Ed25519 key. Returns base64url without padding."""
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    key = load_pem_private_key(private_key_pem.encode(), password=None)
    return base64.urlsafe_b64encode(key.sign(canonical(proposed).encode())).decode().rstrip("=")


def check_amendment(
    current: Dict[str, Any],
    proposed: Dict[str, Any],
    signature: Optional[Dict[str, str]],
    now: Callable[[], str] = lambda: datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
) -> AmendmentCheck:
    """Accept a new revision only with a valid signature from an approver named in the
    revision it replaces. Never raises for a bad proposal: it is refused with reasons."""
    reasons: List[str] = []
    widen: List[str] = []
    digest = ""
    try:
        widen = widening(current, proposed)
        digest = canonical(proposed)
    except Exception as exc:  # noqa: BLE001
        reasons.append(f"the proposal cannot be read: {exc}")
    if proposed.get("id") != current.get("id"):
        reasons.append(f"the proposal is for {proposed.get('id')}, not {current.get('id')}")
    frm, to = current.get("revision", 1), proposed.get("revision", 1)
    if not (isinstance(to, int) and isinstance(frm, int) and to > frm):
        reasons.append(f"revision {to} does not follow {frm}")

    approved_by: Optional[str] = None
    approvers = (current.get("amendment") or {}).get("approvers") or []
    if not approvers:
        reasons.append("the current revision names no approvers, so it can only be changed through the policy repository's own review")
    elif not signature:
        reasons.append("the proposal is not signed")
    else:
        who = next((a for a in approvers if a.get("id") == signature.get("approver")), None)
        if who is None:
            reasons.append(f"{signature.get('approver')} is not an approver of the current revision")
        else:
            try:
                ok = _verify(who["public_key"], digest.encode(), signature.get("signature", ""))
            except RuntimeError as exc:
                reasons.append(str(exc))
                ok = None
            if ok:
                approved_by = who["id"]
            elif ok is False:
                reasons.append(f"the signature does not verify against {who['id']}'s key")

    accepted = not reasons
    record = {
        "kind": "amendment", "envelope_id": current.get("id"),
        "from_revision": current.get("revision"), "to_revision": proposed.get("revision"),
        "result": "accepted" if accepted else "rejected", "reasons": reasons, "widening": widen,
        "approved_by": approved_by if accepted else None,
        "proposal_digest": f"sha256:{hashlib.sha256(digest.encode()).hexdigest()}" if digest else "",
        "decided_at": now(),
    }
    return AmendmentCheck(accepted, reasons, widen, approved_by if accepted else None, record)


class Admission:
    def __init__(self, admitted: bool, reasons: List[str]):
        self.admitted = admitted
        self.reasons = reasons


def admit_component(envelope: Dict[str, Any], manifest: Dict[str, Any]) -> Admission:
    """Admit a component only when everything it declares is inside the envelope."""
    if not isinstance(manifest, dict) or not isinstance(manifest.get("name"), str) or not isinstance(manifest.get("tools"), list):
        return Admission(False, ["the manifest does not name the component and list its tools"])
    reasons: List[str] = []
    tools = envelope.get("tools") or {}
    granted = {g.get("name") for g in tools.get("allow") or []}
    denied = set(tools.get("deny") or []) | set((envelope.get("amendment") or {}).get("protected_tools") or [])
    for t in manifest["tools"]:
        if t in denied:
            reasons.append(f"{t} is refused by the envelope")
        elif t not in granted:
            reasons.append(f"{t} is not on tools.allow")
    egress = envelope.get("egress")
    for host in manifest.get("egress") or []:
        if egress is None:
            reasons.append(f"it reaches {host}, and the envelope declares no egress, so outbound reach cannot be checked")
            continue
        d = next((p for p in egress.get("deny") or [] if host_matches(host, p)), None)
        if d:
            reasons.append(f"it reaches {host}, which egress.deny refuses ({d})")
        elif egress.get("allow") is not None and not any(host_matches(host, p) for p in egress["allow"]):
            reasons.append(f"it reaches {host}, which is not on egress.allow")
    data = envelope.get("data")
    for target in manifest.get("data") or []:
        if data is None:
            continue
        if any(default_data_matcher(target, p) for p in data.get("deny") or []):
            reasons.append(f"it reads {target}, which data.deny refuses")
        elif data.get("allow") is not None and not any(default_data_matcher(target, p) for p in data["allow"]):
            reasons.append(f"it reads {target}, which is not within data.allow")
    if data is not None and data.get("processors") is not None:
        for p in manifest.get("processors") or []:
            if p not in data["processors"]:
                reasons.append(f"it sends data to {p}, which is not on data.processors")
    return Admission(not reasons, reasons)
