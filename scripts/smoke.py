#!/usr/bin/env python3
"""End-to-end provider smoke test with GitHub Actions diagnostics."""

from __future__ import annotations

import json
import os
import socket
import ssl
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROVIDERS = (("anthropic", "Anthropic"), ("openai", "OpenAI"))
REQUEST_TIMEOUT = float(os.environ.get("SMOKE_REQUEST_TIMEOUT", "60"))


@dataclass
class HttpResult:
    status: Optional[int]
    body: str
    network_error: Optional[BaseException] = None

    @property
    def ok(self) -> bool:
        return self.network_error is None and self.status is not None and 200 <= self.status < 300


@dataclass
class ProviderResult:
    key: str
    label: str
    model: str
    available: bool
    detail: str


class SmokeClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def request(
        self,
        path: str,
        *,
        payload: Optional[Dict[str, Any]] = None,
        authenticated: bool = True,
    ) -> HttpResult:
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["Authorization"] = f"Bearer {self.api_key}"

        data = None
        method = "GET"
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
            method = "POST"

        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                body = response.read().decode("utf-8", errors="replace")
                return HttpResult(response.status, body)
        except HTTPError as error:
            try:
                body = error.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            return HttpResult(error.code, body)
        except (URLError, OSError, TimeoutError) as error:
            return HttpResult(None, "", error)


def one_line(value: Any, limit: int = 800) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        text = str(value)
    compact = " ".join(text.split())
    return compact if len(compact) <= limit else compact[: limit - 1] + "…"


def parse_json(text: str) -> Optional[Any]:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def unwrap_error(payload: Any) -> Dict[str, Any]:
    """Unwrap proxy errors, including an upstream JSON body stored in message."""
    current: Any = payload.get("error", payload) if isinstance(payload, dict) else payload

    for _ in range(5):
        if isinstance(current, str):
            decoded = parse_json(current)
            if decoded is None:
                return {"message": current}
            current = decoded.get("error", decoded) if isinstance(decoded, dict) else decoded
            continue

        if not isinstance(current, dict):
            return {"message": one_line(current)}

        message = current.get("message")
        if isinstance(message, str):
            decoded = parse_json(message)
            if decoded is not None:
                candidate = decoded.get("error", decoded) if isinstance(decoded, dict) else decoded
                if isinstance(candidate, (dict, str)):
                    current = candidate
                    continue
        return current

    return current if isinstance(current, dict) else {"message": one_line(current)}


def format_duration(value: Any) -> str:
    try:
        seconds = max(0, int(float(value)))
    except (TypeError, ValueError):
        return one_line(value)

    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    if minutes or hours or days:
        parts.append(f"{minutes}m")
    parts.append(f"{seconds}s")
    return " ".join(parts)


def format_reset_time(value: Any) -> str:
    try:
        timestamp = float(value)
        return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except (TypeError, ValueError, OverflowError, OSError):
        return one_line(value)


def network_failure(error: BaseException) -> str:
    reason = getattr(error, "reason", error)
    detail = one_line(reason) or error.__class__.__name__
    lowered = detail.lower()

    if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in lowered:
        return f"timeout: API request timed out after {REQUEST_TIMEOUT:g}s ({detail})"
    if isinstance(reason, socket.gaierror) or any(
        marker in lowered
        for marker in ("name or service not known", "nodename nor servname", "temporary failure in name resolution")
    ):
        return f"api_unreachable: DNS lookup failed ({detail})"
    if isinstance(reason, ssl.SSLError) or "certificate verify failed" in lowered or "ssl" in lowered:
        return f"tls_error: TLS connection failed ({detail})"
    if isinstance(reason, ConnectionRefusedError) or "connection refused" in lowered:
        return f"api_unreachable: connection refused ({detail})"
    return f"api_unreachable: {detail}"


def field_from(error: Dict[str, Any], payload: Any, *names: str) -> Any:
    for source in (error, payload if isinstance(payload, dict) else {}):
        for name in names:
            if source.get(name) is not None:
                return source[name]
    return None


def diagnose_failure(result: HttpResult, fallback: str = "Provider returned no usable response") -> str:
    if result.network_error is not None:
        return network_failure(result.network_error)

    payload = parse_json(result.body)
    error = unwrap_error(payload if payload is not None else result.body)
    error_type = one_line(field_from(error, payload, "type", "error_type"))
    error_code = one_line(field_from(error, payload, "code"))
    message = field_from(error, payload, "message", "detail", "error_description")
    message_text = one_line(message)
    if not message_text:
        message_text = one_line(result.body) or fallback

    signal = " ".join((error_type, error_code, message_text)).lower()
    status = result.status or 0

    if any(marker in signal for marker in ("usage_limit", "usage limit", "insufficient_quota", "quota exceeded")):
        category = "quota_exhausted"
    elif "rate_limit" in signal or "rate limit" in signal or status == 429:
        category = "rate_limited"
    elif any(marker in signal for marker in ("authentication", "unauthorized", "invalid_api_key", "invalid token", "token expired")) or status in (401, 403):
        category = "authentication_failed"
    elif "timeout" in signal or "timed out" in signal or status in (408, 504):
        category = "timeout"
    elif status >= 500 or error_type in ("upstream_error", "provider_unavailable"):
        category = "upstream_unavailable"
    elif 400 <= status < 500:
        category = "request_rejected"
    else:
        category = "invalid_response"

    details: List[str] = []
    if status:
        details.append(f"HTTP {status}")
    if error_type:
        details.append(f"type={error_type}")
    if error_code and error_code != error_type:
        details.append(f"code={error_code}")

    plan = field_from(error, payload, "plan_type", "plan")
    if plan is not None:
        details.append(f"plan={one_line(plan)}")

    resets_at = field_from(error, payload, "resets_at", "reset_at")
    if resets_at is not None:
        details.append(f"resets_at={format_reset_time(resets_at)}")

    resets_in = field_from(error, payload, "resets_in_seconds", "retry_after")
    if resets_in is not None:
        details.append(f"resets_in={format_duration(resets_in)}")

    suffix = f" [{'; '.join(details)}]" if details else ""
    return f"{category}: {message_text}{suffix}"


def health_hint(payload: Any, provider: str) -> str:
    if not isinstance(payload, dict):
        return ""
    providers = payload.get("providers")
    if not isinstance(providers, dict) or not isinstance(providers.get(provider), dict):
        return "health response omitted this provider"

    health = providers[provider]
    status = one_line(health.get("status")) or "unknown"
    refresh = health.get("refresh") if isinstance(health.get("refresh"), dict) else {}
    refresh_failures = refresh.get("consecutiveFailures", 0)

    if status == "valid" and not refresh_failures:
        return ""

    details = [f"status={status}"]
    for key, label in (("error", "error"), ("expiresAt", "expires_at")):
        if health.get(key):
            details.append(f"{label}={one_line(health[key])}")
    if refresh_failures:
        details.append(f"refresh_failures={refresh_failures}")
    if refresh.get("lastError"):
        details.append(f"last_refresh_error={one_line(refresh['lastError'])}")
    if refresh.get("lastSuccessAt"):
        details.append(f"last_refresh_success={one_line(refresh['lastSuccessAt'])}")
    return "; ".join(details)


def check_health(client: SmokeClient) -> Tuple[Optional[Any], str, Dict[str, str]]:
    print("1. Health")
    result = client.request("/health", authenticated=False)
    if not result.ok:
        issue = f"health_check_failed: {diagnose_failure(result)}"
        print(f"  WARN  {issue}")
        return None, issue, {}

    payload = parse_json(result.body)
    if not isinstance(payload, dict):
        issue = "health_check_failed: invalid_response: /health did not return a JSON object"
        print(f"  WARN  {issue}")
        return None, issue, {}

    print(f"  INFO  overall status={one_line(payload.get('status')) or 'unknown'}")
    hints: Dict[str, str] = {}
    for provider, label in PROVIDERS:
        hint = health_hint(payload, provider)
        hints[provider] = hint
        if hint:
            print(f"  WARN  {label}: {hint}")
        else:
            print(f"  PASS  {label} token/refresh health valid")
    return payload, "", hints


def fetch_models(client: SmokeClient) -> Tuple[Dict[str, str], str]:
    print("\n2. Model catalog")
    result = client.request("/v1/models")
    if not result.ok:
        issue = f"model_catalog_unavailable: {diagnose_failure(result)}"
        print(f"  WARN  {issue}")
        return {}, issue

    payload = parse_json(result.body)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        issue = "model_catalog_unavailable: invalid_response: /v1/models did not return a data array"
        print(f"  WARN  {issue}")
        return {}, issue

    selected: Dict[str, str] = {}
    for provider, label in PROVIDERS:
        ids = [
            model.get("id")
            for model in data
            if isinstance(model, dict)
            and model.get("owned_by") == provider
            and isinstance(model.get("id"), str)
            and model.get("id") != "codex-auto-review"
        ]
        if ids:
            selected[provider] = ids[0]
            print(f"  PASS  {label}: selected {ids[0]}")
        else:
            print(f"  WARN  {label}: no usable chat model returned")
    return selected, ""


def extract_content(body: str) -> str:
    payload = parse_json(body)
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""

    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts).strip()
    return ""


def run_provider(
    client: SmokeClient,
    provider: str,
    label: str,
    model: str,
    messages: List[Dict[str, str]],
    *,
    health: str,
    catalog_issue: str,
    max_tokens: Optional[int] = None,
) -> ProviderResult:
    print(f"\n  {label}" + (f" ({model})" if model else ""))
    if not model:
        reason = catalog_issue or f"model_unavailable: /v1/models returned no {label} chat model"
        if health:
            reason += f"; health: {health}"
        print(f"    DOWN  {reason}")
        return ProviderResult(provider, label, model, False, reason)

    payload: Dict[str, Any] = {"model": model, "messages": messages}
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens

    response = client.request("/v1/chat/completions", payload=payload)
    content = extract_content(response.body) if response.ok else ""
    if content:
        detail = f'response="{one_line(content, 120)}"'
        print(f"    PASS  {model} → {detail}")
        return ProviderResult(provider, label, model, True, detail)

    reason = diagnose_failure(
        response,
        "Successful HTTP response did not contain choices[0].message.content",
    )
    if health:
        reason += f"; health: {health}"
    print(f"    DOWN  {model} → {reason}")
    return ProviderResult(provider, label, model, False, reason)


def gha_escape(value: str, *, property_value: bool = False) -> str:
    escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    if property_value:
        escaped = escaped.replace(":", "%3A").replace(",", "%2C")
    return escaped


def annotate(level: str, title: str, message: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    print(
        f"::{level} title={gha_escape(title, property_value=True)}::"
        f"{gha_escape(message)}"
    )


def markdown_cell(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("\r", "").replace("\n", "<br>")


def write_summary(results: List[ProviderResult], warnings: List[str], failed_count: int) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return

    if failed_count == 0:
        headline = "✅ Both upstream providers are available"
    elif failed_count == 1:
        headline = "⚠️ One upstream provider is degraded"
    else:
        headline = "❌ Both upstream providers are unavailable"

    lines = [
        "## Unified Proxy smoke test",
        "",
        headline,
        "",
        "| Provider | Result | Model | Detail |",
        "| --- | --- | --- | --- |",
    ]
    for result in results:
        if result.available:
            state = "✅ Available"
        elif failed_count == 1:
            state = "⚠️ Unavailable"
        else:
            state = "❌ Unavailable"
        lines.append(
            f"| {result.label} | {state} | {markdown_cell(result.model or '—')} | "
            f"{markdown_cell(result.detail)} |"
        )

    if warnings:
        lines.extend(("", "### Additional diagnostics", ""))
        lines.extend(f"- {markdown_cell(warning)}" for warning in warnings)

    try:
        with Path(summary_path).open("a", encoding="utf-8") as summary:
            summary.write("\n".join(lines) + "\n")
    except OSError as error:
        # Reporting must not turn a one-provider warning into a failed job.
        print(f"  WARN  could not write GITHUB_STEP_SUMMARY: {one_line(error)}")


def configuration_failure(message: str) -> int:
    print(f"ERROR: {message}")
    annotate("error", "Smoke test configuration error", message)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as summary:
            summary.write(f"## Unified Proxy smoke test\n\n❌ {markdown_cell(message)}\n")
    return 1


def main() -> int:
    base_url = os.environ.get("BASE_URL", "").strip()
    api_key = os.environ.get("PROXY_API_KEY", "").strip()
    if not base_url or not api_key:
        return configuration_failure(
            "BASE_URL and PROXY_API_KEY are required; set them in the environment or .env.secrets"
        )

    print("=== Unified Proxy Smoke Test ===")
    print(f"  Target: {base_url}")
    client = SmokeClient(base_url, api_key)

    _, health_issue, health_hints = check_health(client)
    models, catalog_issue = fetch_models(client)

    anthropic_model = os.environ.get("SMOKE_ANTHROPIC_MODEL", "").strip() or models.get("anthropic", "")
    openai_model = os.environ.get("SMOKE_OPENAI_MODEL", "").strip() or models.get("openai", "")

    print("\n3. Live inference")
    results = [
        run_provider(
            client,
            "anthropic",
            "Anthropic",
            anthropic_model,
            [{"role": "user", "content": "Reply with exactly the word: pong"}],
            max_tokens=10,
            health=health_hints.get("anthropic", ""),
            catalog_issue=catalog_issue,
        ),
        run_provider(
            client,
            "openai",
            "OpenAI",
            openai_model,
            [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Reply with exactly the word: pong"},
            ],
            health=health_hints.get("openai", ""),
            catalog_issue=catalog_issue,
        ),
    ]

    failures = [result for result in results if not result.available]
    warnings: List[str] = []
    if health_issue:
        warnings.append(health_issue)
    for result in results:
        hint = health_hints.get(result.key, "")
        if result.available and hint:
            warnings.append(f"{result.label} live inference passed, but /health reported: {hint}")
    if catalog_issue and all(catalog_issue not in result.detail for result in failures):
        warnings.append(catalog_issue)

    print("\n=== Provider availability ===")
    for result in results:
        state = "AVAILABLE" if result.available else "UNAVAILABLE"
        print(f"  {result.label:<10} {state}: {result.detail}")

    if len(failures) == 0:
        print("\nPASS: both upstream providers are available")
    elif len(failures) == 1:
        failed = failures[0]
        print(f"\nWARNING: {failed.label} is unavailable; the other provider is still usable")
        annotate("warning", f"{failed.label} provider unavailable", failed.detail)
    else:
        print("\nFAIL: both upstream providers are unavailable")
        for failed in failures:
            annotate("error", f"{failed.label} provider unavailable", failed.detail)

    for warning in warnings:
        print(f"  WARN  {warning}")
        annotate("warning", "Smoke test diagnostic", warning)

    write_summary(results, warnings, len(failures))
    return 1 if len(failures) == len(PROVIDERS) else 0


if __name__ == "__main__":
    sys.exit(main())
