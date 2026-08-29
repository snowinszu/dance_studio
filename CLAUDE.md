## Design System

Active design system: 晓·乐舞艺术空间 (Createthisprojecta)
Token file: `colors_and_type.css` — link this in every HTML file's `<head>`.
Spec: `DESIGN.md` — follow component rules, color tokens, and anti-patterns.
UI kit template: `ui_kits/app/index.html` — copy as starting point for new screens.

Rules:
- Never use raw hex values; always use `var(--token-name)`
- Hover states must not reduce text contrast
- Accent color (`--accent`) appears at most twice per screen
