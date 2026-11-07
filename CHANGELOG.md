# Changelog

All notable changes to PlainView are documented here. This project follows [Semantic Versioning](https://semver.org/).
Weekly filter-list refreshes are published as `x.y.z.N` builds and aren't listed individually.

## [1.0.0] - 2026-11-07

First release.

### Added
- Network blocking with the browser's built-in `declarativeNetRequest` engine, using rules compiled from EasyList, EasyPrivacy, the EasyList Cookie List and the URLhaus malicious-hosts list (14,701 rules)
- Element hiding: site-specific rules injected when a page loads, and generic rules applied on demand (only rules matching class and id names present on the page), which keeps page-load overhead low
- Pop-up ad blocking for domain-based `$popup` filters
- Toolbar popup: per-site on/off switch, pause everywhere, blocked-request count with per-list breakdown, element picker, link to settings
- Settings page: list toggles, disabled-sites manager, custom filters in Adblock Plus syntax with error reporting, settings export and import
- Chromium (Chrome, Edge, Brave) and Firefox (experimental) builds
- Unit tests (25) and end-to-end tests in real Chrome (21 checks), plus GitHub Actions for CI, releases and weekly filter updates
