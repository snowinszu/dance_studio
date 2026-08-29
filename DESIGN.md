# 晓乐舞艺术空间 · Design System

> **Createthisprojecta** — Category: Project Design System · Surface: web (desktop-first admin)
> Source project: 晓乐舞艺术空间桌面应用首页 (b396cdad-08f8-4279-ad12-4e2311f21261)
> All tokens extracted directly from `dance-studio-home-v4.html`. See `context/provenance.md` for full extraction log.

---

## 0. Product Context

**Product name:** 晓·乐舞艺术空间 综合管理平台 (Xiaoyue Dance Art Space — Integrated Management Platform)

**Domain:** Dance-studio operations management — a private back-office tool for studio staff.

**Primary surfaces:** Desktop web admin dashboard (1120px max-width, min 960px). Staff use this daily to manage attendance, inventory, class schedules, student records, finances, notices, room bookings, and data reports.

**Source evidence:** `dance-studio-home-v4.html` — a complete 550-line single-page prototype implementing the homepage with sticky nav, personalized greeting, 4×2 app card grid, and real-time clock.

**Design system ID:** `user:design-system` · **New project ID:** `2114d85f-673f-40e8-9a81-5d5bb72f62ec`

---

## 1. Visual Theme & Atmosphere

**Product context:** 晓·乐舞艺术空间 is a dance-studio management platform for internal staff. The interface adopts a Xiaohongshu (RED app) visual language: vibrant, warm, and lifestyle-oriented, while maintaining operational clarity for daily back-office work.

**Mood keywords:** warm · lively · approachable · non-corporate · colorful-but-not-chaotic

**Source evidence:** The source project (`dance-studio-home-v4.html`) opens with the CSS comment "小红书风格：品牌红 + 纯白 + 八色应用卡片顶栏" and uses "缤纷生活感调色板" (vibrant lifestyle palette) as its naming philosophy for the eight card colors.

**Core atmosphere rules:**
- Brand red (`--accent`) anchors every focal point: nav mark, badges, avatar background, date labels
- Warm near-white background (`--bg`) rather than pure white — softens the overall tone
- Eight distinct card-top colors (cc-1 to cc-8) distinguish modules visually, not just through iconography
- Cards lift 4px on hover with expanding shadow — conveys lightness and responsiveness

One-line summary: **A Xiaohongshu-style desktop admin interface that uses a lively lifestyle color palette and large-radius cards to make operational tasks feel friendly and approachable.**

---

## 2. Color

All color values are extracted verbatim from the source file `:root` block. No values are estimated.

### Semantic base palette

| Token | OKLCH value | Role |
|-------|-------------|------|
| `--bg` | `oklch(99.5% 0.003 15)` | Page background — warm near-white |
| `--surface` | `oklch(100% 0 0)` | Card / panel surface — pure white |
| `--fg` | `oklch(14% 0.010 0)` | Primary text — near black |
| `--muted` | `oklch(55% 0.008 0)` | Secondary text, timestamps, descriptions |
| `--border` | `oklch(93% 0.004 0)` | Dividers, card outlines |
| `--accent` | `oklch(57% 0.235 17)` | Brand primary — Xiaohongshu red (≈ #FF2442) |
| `--accent-soft` | `color-mix(in oklch, var(--accent) 10%, transparent)` | Very subtle brand tint |
| `--accent-mid` | `color-mix(in oklch, var(--accent) 16%, transparent)` | Badge background |
| `--fg-soft` | `color-mix(in oklch, var(--fg) 5%, transparent)` | Shadow base color |

### Application card color palette (cc-1 to cc-8)

Each app card top-bar carries a unique theme color. Source comment: "八张应用卡顶栏色——缤纷生活感调色板".

| Token | OKLCH value | Color name | Module |
|-------|-------------|------------|--------|
| `--cc-1` | `oklch(68% 0.165 25)` | 活力珊瑚 Coral | 考勤管理 Attendance |
| `--cc-2` | `oklch(65% 0.130 152)` | 鼠尾草绿 Sage Green | 库存管理 Inventory |
| `--cc-3` | `oklch(63% 0.155 234)` | 晴空蓝 Sky Blue | 课程安排 Schedule |
| `--cc-4` | `oklch(62% 0.135 293)` | 薰衣草紫 Lavender | 学员档案 Students |
| `--cc-5` | `oklch(73% 0.135 70)` | 琥珀金 Amber | 收支记账 Finance |
| `--cc-6` | `oklch(67% 0.145 356)` | 玫瑰红 Rose | 通知公告 Notices |
| `--cc-7` | `oklch(66% 0.130 192)` | 海洋青 Teal | 教室预约 Rooms |
| `--cc-8` | `oklch(59% 0.145 308)` | 暗梅紫 Plum | 数据报表 Reports |

Card-top gradient: `linear-gradient(145deg, color-mix(in oklch, var(--cc) 75%, var(--surface)), var(--cc))`

### Color extension rules

- All derived colors must use `oklch()` or `color-mix()` from existing tokens. Never hard-code hex values.
- Hover state: adjust background L channel by ±0.06–0.12. **Never** change foreground text to `--muted` or a lighter color.
- Contrast requirements: body text ≥ 4.5:1, large text and icons ≥ 3:1 (WCAG AA).

---

## 3. Typography

Source comment: "小红书使用统一无衬线字体，以字重区分信息层级" — single-family strategy, weight hierarchy.

### Font stacks

```css
--font-display: -apple-system, BlinkMacSystemFont, 'PingFang SC',
                'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif;
--font-body:    /* identical to display — intentional single-family strategy */
--font-mono:    ui-monospace, 'SF Mono', Menlo, monospace;
```

> `--font-display` and `--font-body` share the same stack. This is an intentional Chinese-design convention — PingFang SC covers the full weight range, making a separate display typeface unnecessary.

### Type scale

| Role | Size | Weight | Line-height | Letter-spacing |
|------|------|--------|-------------|----------------|
| Hero title | `clamp(32px, 4vw, 48px)` | 800 | 1.08 | -0.03em |
| Date numeral | `42px` | 800 | 1.0 | -0.04em |
| Section heading | `18px` | 700 | 1.4 | -0.015em |
| Nav title / card name | `15px` | 700 | 1.4 | 0.01em |
| Body / greeting | `15px` | 400 | 1.6 | — |
| Card description | `12.5px` | 400 | 1.5 | — |
| Count / helper | `13px` | 400 | 1.4 | — |
| Badge label | `11px` | 600 | — | 0.04em |
| Footer text | `11.5px` | 400 | — | 0.01em |
| Monospace (clock) | `12px` | 400 | — | 0.08em |

Base `body`: `font-size: 15px`, `line-height: 1.6`, `-webkit-font-smoothing: antialiased`

---

## 4. Spacing

Base unit: 4px. Values extracted from layout measurements in source file.

### Spacing scale

| Name | Value | Source usage |
|------|-------|--------------|
| space-1 | 4px | badge dot-to-text gap |
| space-2 | 6px | badge inner gap |
| space-3 | 9px | nav brand gap |
| space-4 | 14px | card grid gap · nav-right gap |
| space-5 | 16px | card body padding |
| space-6 | 20px | apps-header margin-bottom |
| space-7 | 24px | greeting grid gap |
| space-8 | 36px | greeting section padding-bottom |
| space-9 | 40px | main content horizontal padding |
| space-10 | 44px | greeting section margin-bottom |
| space-11 | 72px | main content bottom padding |

### Border radius tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--radius` | `12px` | Base components |
| `--radius-lg` | `18px` | Date card |
| `--radius-xl` | `24px` | Application cards |
| `--radius-pill` | `999px` | Badges, tags |
| `--radius-icon` | `14px` | Card icon container |
| `--radius-mark` | `8px` | Nav brand mark |
| (avatar) | `50%` | User avatar |

### Shadow tokens

| Name | Value | Usage |
|------|-------|-------|
| `--shadow-card` | `0 1px 4px fg@5%, 0 4px 18px fg@5%` | App card default |
| `--shadow-card-hover` | `0 3px 10px fg@8%, 0 10px 36px fg@8%` | App card hover |
| `--shadow-date` | `0 2px 10px fg@5%` | Date card |

---

## 5. Layout & Composition

### Page structure

```
┌──────────────────────────────────────────────────────────────────────┐
│  .topnav  sticky h=52px · frosted glass · border-bottom              │
├──────────────────────────────────────────────────────────────────────┤
│  main  max-w:1120px · mx:auto · px:40px · pt:40px · pb:72px          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  .greeting-section  grid: 1fr auto · align-items:end           │  │
│  │    left: badge + h1 + subtitle                                 │  │
│  │    right: .date-card                                           │  │
│  ├────────────────────────────────────────────────────────────────┤  │
│  │  .apps-header  flex space-between                              │  │
│  │  .apps-grid  repeat(4, 1fr) gap:14px                           │  │
│  │    .app-card × 8                                               │  │
│  └────────────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────┤
│  footer  border-top · px:40px · center · 11.5px muted                │
└──────────────────────────────────────────────────────────────────────┘
```

### Responsive breakpoints

| Breakpoint | Changes |
|------------|---------|
| ≥ 921px | Standard desktop: 4-column grid, date-card visible, 40px padding |
| ≤ 920px | Padding → 20px; greeting → single column; date-card hidden; grid → 2 columns |

### Layout constraints

- Global max-width: **1120px**, horizontally centered
- App card grid: `repeat(4, 1fr)`, gap `14px`
- Greeting: `grid-template-columns: 1fr auto`, `align-items: end`

---

## 6. Components

### Navigation bar `.topnav`

Sticky, height 52px. Frosted-glass background: `color-mix(in oklch, var(--surface) 88%, transparent)` + `backdrop-filter: blur(20px) saturate(1.6)`. 1px `--border` bottom. Left: brand mark + title. Right: clock + avatar.

### Brand mark `.xhs-mark`

28×28px, `--radius-mark` (8px) corners, `--accent` background, 16×16px white SVG icon. Mirrors the Xiaohongshu signature red square mark.

### Status badge `.greeting-badge`

Pill shape (`--radius-pill`), padding `4px 12px 4px 8px`, background `--accent-mid`. Contains: 6px accent dot + 11px / fw600 / ls 0.04em accent-colored text.

### Application card `.app-card`

Two-part layout: colored top rail (96px) + white body (card name + description).

- Top rail: `linear-gradient(145deg, cc@75% blended with surface, pure cc)`
- Icon container: 50×50px, 14px radius, `surface@28%` background, white SVG icon
- `::after` pseudo: decorative highlight circle top-right corner
- Color injected via `style="--cc: var(--cc-N)"`

States: Default → shadow-card; Hover → translateY(-4px) + shadow-card-hover (0.18s/0.22s ease); Active → translateY(-1px); Focus-visible → 2px accent outline.

### Date card `.date-card`

Three-line: weekday (mono 11px uppercase accent) / day number (42px fw800) / month (12px muted). Hidden on mobile (≤920px).

### Avatar `.avatar`

32×32px circle, `--accent` fill, white text fw700. Hover: `opacity: 0.85` (0.15s).

### Footer `footer`

Centered 11.5px `--muted`. Separator `·` color: `color-mix(in oklch, var(--accent) 45%, var(--muted))`.

---

## 7. Motion & Interaction

### Transition specifications

| Property | Duration | Easing | Usage |
|----------|----------|--------|-------|
| `transform` | `0.18s` | `ease` | Card hover lift |
| `box-shadow` | `0.22s` | `ease` | Card shadow expansion |
| `opacity` | `0.15s` | linear | Avatar hover |

### Interaction state rules

- Hover state must **never** change foreground text color to `--muted` or any value closer to the background
- Every focusable element requires a visible `:focus-visible` ring — `2px solid var(--accent)`, `outline-offset: 2px`
- Solid buttons on hover: move background L by ±0.06–0.12 on the OKLch L axis
- Disabled is the only state allowed to reduce contrast
- Touch targets minimum 44px

### Motion philosophy

Micro-interactions (4px lift + shadow spread) communicate responsiveness without distracting. No large slide-in or fade animations needed.

---

## 8. Voice & Brand

### Product name

- Full: 晓·乐舞艺术空间 综合管理平台
- Short: 晓·乐舞 / 晓乐舞
- Middle dot: U+00B7 `·`, not U+2022 `•`

### Copy tone

- Warm and approachable, not formal corporate language
- Time-of-day greetings: 早上好 / 下午好 / 晚上好 + short encouraging phrase
- Module descriptions: ≤10 Chinese characters, direct and specific: "员工打卡与出勤统计"
- Quantities use Arabic numerals: "8 个应用"

### Format conventions

- Dates: Chinese locale (`2026年8月28日`)
- Time: 24h or zh-CN locale format
- Footer pattern: `晓·乐舞艺术空间 · 综合管理平台 · 版权所有`

---

## 9. Anti-patterns

The following choices are explicitly prohibited in this design system:

- Cold blue/gray "tech" color schemes — contradicts the warm lifestyle brand
- Icons beside every section heading — icons are reserved for app card identification
- Hover states that change foreground text to `--muted` or any lighter tone
- Large gradient overlays beyond the card-top rail gradient
- Inter, Roboto, or Fraunces as display typefaces
- Two solid primary-style buttons for the same action in one viewport
- Hand-drawn SVG character illustrations
- Purple gradient full-page backgrounds
- `cursor: pointer` on non-interactive decorative elements
- Cards overflowing their containers or causing horizontal scroll
- Fabricated metrics or meaningless placeholder numbers
- Warm beige / cream backgrounds (unless brand explicitly updates)
