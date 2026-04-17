# Screen Reader Testing

A practical screen reader testing protocol for accessibility audits. Not a textbook — a structured procedure you can follow in 5-15 minutes per page.

---

## Which Screen Reader

| Platform | Screen Reader | Cost | Browser |
|----------|--------------|------|---------|
| macOS | VoiceOver | Built-in (Cmd+F5) | Safari (best support) or Chrome |
| Windows | NVDA | Free (nvaccess.org) | Firefox (best support) or Chrome |
| Windows | JAWS | Paid ($90/yr) | Chrome or Firefox |
| iOS | VoiceOver | Built-in (Settings > Accessibility) | Safari |
| Android | TalkBack | Built-in (Settings > Accessibility) | Chrome |

**For most web audits:** VoiceOver on Mac or NVDA on Windows. Both are free.

---

## Essential Shortcuts

### VoiceOver (macOS)

VO = Control + Option (the "VoiceOver keys")

| Action | Shortcut |
|--------|----------|
| Turn on/off | Cmd + F5 |
| Read next item | VO + Right Arrow |
| Read previous item | VO + Left Arrow |
| Navigate by headings | VO + Cmd + H (next), VO + Cmd + Shift + H (prev) |
| Navigate by landmarks | VO + Cmd + { or } |
| Navigate by links | VO + Cmd + L |
| Navigate by form controls | VO + Cmd + J |
| Rotor (navigation options) | VO + U |
| Activate (click) | VO + Space |
| Read all from cursor | VO + A |
| Stop reading | Control |
| Tab to next focusable | Tab |

**Important:** Safari + VoiceOver is the most-tested combination on macOS. Chrome support is good but some ARIA behaviors differ.

### NVDA (Windows)

NVDA key = Insert (or CapsLock if configured)

| Action | Shortcut |
|--------|----------|
| Turn on | Ctrl + Alt + N (after install) |
| Turn off | NVDA + Q |
| Read next item | Down Arrow |
| Read previous item | Up Arrow |
| Navigate by headings | H (next), Shift + H (prev) |
| Navigate by landmarks | D (next), Shift + D (prev) |
| Navigate by form controls | F (next), Shift + F (prev) |
| Navigate by links | K (unvisited), V (visited) |
| Elements list (rotor equivalent) | NVDA + F7 |
| Activate (click) | Enter or Space |
| Read all from cursor | NVDA + Down Arrow |
| Stop reading | Control |
| Toggle browse/focus mode | NVDA + Space |

**Important:** NVDA has two modes. **Browse mode** lets you navigate with H, D, F keys. **Focus mode** passes keys to the web page (for forms, custom widgets). NVDA auto-switches, but if shortcuts stop working, press NVDA + Space.

---

## 5-Minute Smoke Test

Run this on each Tier 1 page. The manual testing guide provides page-specific expected values (headings, landmarks, form controls).

### 1. Page Title

Open the page. The screen reader should announce the page title.

- [ ] Title is announced
- [ ] Title identifies the page (not just "Home" or the app name)

**If it fails:** SC 2.4.2 (Page Titled). Severity: serious.

### 2. Heading Navigation

Navigate through all headings (VoiceOver: VO+Cmd+H | NVDA: H).

- [ ] All visible headings are announced
- [ ] Heading levels are announced correctly (h1, h2, h3...)
- [ ] No skipped heading levels
- [ ] Headings are descriptive (not "Section 1", "Untitled")

**If it fails:** SC 1.3.1 (Info and Relationships), SC 2.4.6 (Headings and Labels). Severity: serious if headings missing, moderate if levels skipped.

### 3. Landmark Navigation

Navigate through landmarks (VoiceOver: VO+Cmd+{ | NVDA: D).

- [ ] Main content region is announced
- [ ] Navigation regions are announced with labels
- [ ] Banner (header) and contentinfo (footer) are present
- [ ] Search region is announced if site has search

**If it fails:** SC 1.3.1. Severity: moderate (landmarks help navigation but are not strictly required if skip links exist).

### 4. Form Controls

Tab through form controls.

- [ ] Each input's label is announced when it receives focus
- [ ] Required fields are indicated (e.g., "required" announced)
- [ ] Input type is announced (text, email, password, checkbox, etc.)
- [ ] Grouped fields (radio buttons, fieldsets) announce their group label

**If it fails:** SC 1.3.1 (missing labels), SC 4.1.2 (Name, Role, Value), SC 3.3.2 (Labels or Instructions). Severity: serious if label missing, moderate if incomplete.

### 5. Live Region Announcements

Trigger dynamic content (submit a form, apply a filter, add to cart, trigger an error).

- [ ] The screen reader announces the change without requiring navigation
- [ ] The announcement is meaningful (e.g., "3 results found" not just "region updated")
- [ ] Error messages are announced when they appear
- [ ] Loading states are announced ("Loading..." or equivalent)

**If it fails:** SC 4.1.3 (Status Messages). Severity: serious for errors not announced, moderate for status updates not announced.

---

## Extended Checks (when time allows)

### Image Alt Text

Navigate through images (VoiceOver: VO+Cmd+G | NVDA: G).

- [ ] Informative images have descriptive alt text
- [ ] Decorative images are skipped (not announced or announced as "image" only)
- [ ] Complex images (charts, diagrams) have extended descriptions

### Link Purpose

Navigate through links (VoiceOver: VO+Cmd+L | NVDA: K).

- [ ] Each link's purpose is clear from its text (or text + context)
- [ ] No "click here" or "read more" without context
- [ ] Links to new windows/tabs indicate this

### Modal/Dialog Behavior

Open a modal or dialog.

- [ ] Screen reader announces "dialog" or similar role
- [ ] Dialog label/title is announced
- [ ] Focus is inside the dialog
- [ ] Background content is not reachable (focus trap)
- [ ] Escape closes the dialog
- [ ] Focus returns to the trigger element after close

---

## Common Gotchas

1. **VoiceOver + Chrome vs Safari:** ARIA `role="application"` behaves differently. Safari is the reference browser for VoiceOver testing.

2. **NVDA browse mode vs focus mode:** If you're in a form and NVDA stops responding to H/D navigation keys, you're in focus mode. Press NVDA + Space to toggle back to browse mode.

3. **aria-hidden="true":** Content with this attribute is invisible to screen readers. If important content is hidden, it's a finding.

4. **Dynamic content not announced:** If you trigger an action and nothing is announced, check if the new content is inside an `aria-live` region. If not, that's likely the bug.

5. **Redundant announcements:** Screen readers may announce things twice if both `aria-label` and visible text are present. This is annoying but usually not a WCAG failure.

6. **VoiceOver verbosity:** VoiceOver announces a lot of detail by default (element type, state, hint). This is normal behavior, not a bug.

---

## Recording Screen Reader Findings

Use `"source": "screen-reader"` in findings.jsonl:

```json
{"id":"F-SR-001","sc":"4.1.2","sc_name":"Name, Role, Value","page":"/contact","phase":"names","severity":"serious","title":"Form input missing label","observed":"VoiceOver announces 'text field' with no label when tabbing to email input","expected":"VoiceOver announces 'Email address, text field'","evidence":"Screen reader testing, VoiceOver 15 + Safari 18","source":"screen-reader"}
```

Include the screen reader name and version in the evidence field. Different screen readers may produce different results for the same markup.
