<div align="center"><a name="readme-top"></a>

[![][image-banner]][website]

An open-source AI-powered language learning extension for browsers.<br/>
Supports immersive translation, article analysis, multiple AI models, and more.<br/>
Master languages effortlessly and deeply with AI, right in your browser.

**English** | [简体中文](./README.zh-CN.md) | [Official Website](https://readfrog.app)

<!-- SHIELD GROUP -->

[![][extension-release-shield]][github-release-link]
[![][chrome-version-shield]][chrome-store-link]
[![][edge-version-shield]][edge-store-link]<br/>
[![][discord-shield]][discord-link]
[![][chrome-users-shield]][chrome-store-link]
[![][edge-users-shield]][edge-store-link]<br/>
[![][star-history-shield]][star-history-link]
[![][contributors-shield]][contributors-link]
![][last-commit-shield]
[![][issues-shield]][issues-link]<br/>
[![][sponsor-shield]][sponsor-link]

</div>

<details>
<summary><kbd>Table of contents</kbd></summary>

#### TOC

- [📺 Demo](#-demo)
- [👋🏻 Getting Started \& Join Our Community](#-getting-started--join-our-community)
  - [Download](#download)
  - [Community](#community)
- [✨ Features](#-features)
- [🤝 Contribute](#-contribute)
  - [Contribute Code](#contribute-code)
- [❤️ Sponsors](#️-sponsors)

<br/>

</details>

## 📺 Demo

![Read Frog](/assets/read-demo.gif)

<div align="center">
  <img src="assets/node-translation-demo.gif" width="38%" alt="Read Frog Popup Interface" />
  <img src="assets/page-translation-demo.gif" width="60%" alt="Read Frog Translation Interface" />
</div>

## 👋🏻 Getting Started & Join Our Community

Read Frog's vision is to provide an easy-to-use, intelligent, and personalized language learning experience for language learners of all levels. This has become possible in the AI era, but there are few products on the market that meet this demand. Therefore, we decided to take matters into our own hands and ultimately make the world no longer reliant on human language instructors.

Whether you are a user or a developer, Read Frog will be an important part of your journey toward this vision. Please be aware that Read Frog is currently under active development, and feedback is welcome for any [issues][issues-link] encountered.

### Download

| Browser | Version                                         | Download                                                          |
| ------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| Chrome  | [![][chrome-version-shield]][chrome-store-link] | [Chrome Web Store][chrome-store-link] or [中国镜像][crxsoso-link] |
| Edge    | [![][edge-version-shield]][edge-store-link]     | [Microsoft Edge Addons][edge-store-link]                          |

### Community

| [![][discord-shield-badge]][discord-link] | In Discord ask questions, and connect with developers.                                 |
| :---------------------------------------- | :------------------------------------------------------------------------------------- |
| [![][wechat-shield-badge]][wechat-link]   | If you are in mainland China, you can add the WeChat account to join the WeChat group. |

> \[!IMPORTANT]
>
> **⭐️ Star Us**, You will receive all release notifications from GitHub without any delay \~

[![][image-star]][github-star-link]

<details>
<summary>
  <kbd>Star History</kbd>
</summary>

<a href="https://www.star-history.com/#mengxi-ream/read-frog&Timeline">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=mengxi-ream/read-frog&type=Timeline&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=mengxi-ream/read-frog&type=Timeline" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=mengxi-ream/read-frog&type=Timeline" />
 </picture>
</a>

</details>

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ✨ Features

Transform your everyday web reading into an immersive language learning journey! Read Frog is your intelligent companion that makes language learning natural and enjoyable.

- Immersive Translation: Translate elements directly adjacent to the original elements on the webpage
- Smart Content Extraction: Automatically identifies and extracts the main content from articles
- Comprehensive Explanations: Get detailed explanations of words, phrases, and sentences based on your language level
- Contextual Learning: Learn languages through content you're actually interested in
- Multiple AI Models: OpenAI, DeepSeek, and more in the future

Whether you're reading news, articles, or any web content, Read Frog helps you understand and learn languages in depth. It's like having a language teacher right in your browser!

Perfect for:

- Language learners who want to learn through authentic content
- Readers who want to understand foreign language articles better
- Anyone who wants to make their web browsing more educational

Join our growing community of language learners and help shape the future of Read Frog!

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ⚡ Translation-Only Performance Plan

To make the **Translation Only** mode feel instant on long-form pages, we track and optimize the full pipeline—DOM extraction → chunking → provider requests → rendering. The plan below doubles as a checklist for contributors:

- **Baseline & Profiling**: instrumentation (see `translator/README.md`) captures extraction, queue wait, API latency, and overlay render cost for popup vs floating button. Sample stats live in the profiling appendix and must be updated before/after every major optimization.
- **Queue Tuning**: `request-queue.ts` now exposes a translation-only profile (3–4 concurrent chunks, reduced jitter). `translation-queues.ts` picks the profile whenever Translation Only mode is active so batches leave the queue faster.
- **Chunk Strategy**: `sendInBatchesWithFixedDelay` and `TranslationTaskQueue` merge adjacent short paragraphs and keep chunk length within ~400–600 characters, preventing tiny payloads that waste round-trips while respecting provider token budgets.
- **HTML → Plain Text**: incoming payloads pass through the new HTML cleaner (strips tags, preserves semantic hints, collapses whitespace) before hashing, caching, or sending to GenAI. This keeps token counts predictable and removes a major latency cause.
- **Streaming & Rendering**: `Translator.DisplayLoop` and the React overlay emit each chunk as soon as it lands while trimming `Caption.Contexts` to avoid expensive reflows.
- **Caching & Dedup**: cleaned-text hashes feed Dexie’s `translationCache`, so revisiting a page reuses translations instantly. GET session checks use `backgroundFetch` cacheConfig to avoid hammering GenAI auth.
- **Error Fast-Fail & Retries**: provider failures cancel queued work via `AbortController`, show actionable toasts, and let users retry without reloading; recoverable GenAI errors auto-resume with exponential backoff.
- **Regression Tests**: scripted e2e runs (Val-town snippet, Kompas article, long technical blog) enforce a <3s budget for ~1k words. CI stores the captured metrics so we can spot regressions.

Refer to the profiling appendix in `translator/README.md` for raw traces and update it whenever you touch this pipeline.

### 🧪 Profiling Appendix (Dev Only)

The extension now emits dev-only `[Perf]` logs plus `performance.mark/measure` entries for both the Read flow (`useReadArticle`) and the background translation queue. When you run the extension via `pnpm dev`, the popup also surfaces a **Perf Lab** card (dev-only, described in [`docs/perf-roadmap.md`](./docs/perf-roadmap.md)) that:

- Streams live samples from Dexie for the active tab + translation mode, showing avg/p95 deltas, stage breakdowns, and the latest pulses.
- Lets QA clear samples (Reset) before a run and export JSON bundles that can be attached to bugs or shared in chat.
- Updates automatically every few seconds, so you can keep it open while iterating on Translation Only tweaks.

To capture a new baseline:

- Open Chrome DevTools → Performance, start recording, trigger a translation (popup or floating button), then stop recording to inspect the `rf-perf:*` marks.
- Alternatively, watch the console for `[Perf]` entries. Each log includes `deltaMs` and `totalMs`, so you can copy/paste directly into spreadsheets.
- Always profile both popup and floating button surfaces—the DOM cost differs.

| Surface          | Extraction (ms) | Queue/Batching (ms) | API Round-Trip (ms) | Render/Applying (ms) |
| ---------------- | --------------- | ------------------- | ------------------- | -------------------- |
| Popup (HN story) | 480             | 65                  | 1180                | 90                   |
| Floating button  | 610             | 80                  | 1310                | 120                  |

> Example captured on Chrome 130 / Windows 11 / i7-12700H / wired network. Re-run and commit updated numbers whenever you touch the translation pipeline so regressions stay visible.

## Samsung GenAI (SSO-only)

Need to use Samsung's internal GenAI portal? Read Frog already ships with a disabled-by-default provider preset:

1. Open **Options → API Providers**, enable **Samsung GenAI**, and set it as the default Read/Translate provider as needed.
2. No API key is required. Instead, stay logged into <https://genai.sec.samsung.net> inside the same browser profile that runs the extension.
3. When Read Frog notices your GenAI session has expired, it automatically opens a new tab pointing to Samsung's SSO page, waits for the login to finish, reuses the refreshed cookies, and closes the tab.
4. For a detailed step-by-step walkthrough of the SSO redirects (useful for QA or troubleshooting), see [`manual run in browser.txt`](./manual%20run%20in%20browser.txt).

> **Tip:** you can manually visit <https://genai.sec.samsung.net/api/account/auth/session>—if it returns user metadata, the session is warm and Read Frog can start translating immediately.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🤝 Contribute

Contributions of all types are more than welcome.

1. Promote Read Frog to your friends and family.
2. Report [issues][issues-link] and feedback.
3. Contribute code.

### Contribute Code

Project Structure: [DeepWiki](https://deepwiki.com/mengxi-ream/read-frog)

Ask AI to understand the project: [Dosu](https://app.dosu.dev/29569286-71ba-47dd-b038-c7ab1b9d0df7/documents)

Check out the [Contribution Guide](https://readfrog.app/en/tutorial/contribution) for more details.

<a href="https://github.com/mengxi-ream/read-frog/graphs/contributors">
  <table>
    <tr>
      <th colspan="2">
        <br>
        <img src="https://contrib.rocks/image?repo=mengxi-ream/read-frog"><br>
        <br>
      </th>
    </tr>
    <!-- <tr>
      <td>
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://next.ossinsight.io/widgets/official/compose-recent-top-contributors/thumbnail.png?repo_id=967738751&image_size=auto&color_scheme=dark" width="373" height="auto">
          <img alt="Top Contributors of mengxi-ream/read-frog - Last 28 days" src="https://next.ossinsight.io/widgets/official/compose-recent-top-contributors/thumbnail.png?repo_id=967738751&image_size=auto&color_scheme=light" width="373" height="auto">
        </picture>
      </td>
      <td rowspan="2">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://next.ossinsight.io/widgets/official/compose-last-28-days-stats/thumbnail.png?repo_id=967738751&image_size=4x7&color_scheme=dark" width="655" height="auto">
          <img alt="Performance Stats of mengxi-ream/read-frog - Last 28 days" src="https://next.ossinsight.io/widgets/official/compose-last-28-days-stats/thumbnail.png?repo_id=967738751&image_size=auto&color_scheme=light" width="655" height="auto">
        </picture>
      </td>
    </tr> -->
  </table>
</a>

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ❤️ Sponsors

Every donation helps us build a better language learning experience. Thank you for supporting our mission!

[![][sponsor-image]][sponsor-link]

<div align="right">

[![][back-to-top]](#readme-top)

</div>

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[chrome-store-link]: https://chromewebstore.google.com/detail/read-frog-open-source-ai/modkelfkcfjpgbfmnbnllalkiogfofhb
[chrome-users-shield]: https://img.shields.io/chrome-web-store/users/modkelfkcfjpgbfmnbnllalkiogfofhb?style=flat-square&label=Chrome%20Users&color=orange&labelColor=black
[chrome-version-shield]: https://img.shields.io/chrome-web-store/v/modkelfkcfjpgbfmnbnllalkiogfofhb?style=flat-square&label=Chrome%20Version&labelColor=black&color=orange
[contributors-link]: https://github.com/mengxi-ream/read-frog/graphs/contributors
[contributors-shield]: https://img.shields.io/github/contributors/mengxi-ream/read-frog?style=flat-square&labelColor=black
[crxsoso-link]: https://www.crxsoso.com/webstore/detail/modkelfkcfjpgbfmnbnllalkiogfofhb
[discord-link]: https://discord.gg/ej45e3PezJ
[discord-shield]: https://img.shields.io/discord/1371229720942874646?style=flat-square&label=Discord&logo=discord&logoColor=white&color=5865F2&labelColor=black
[discord-shield-badge]: https://img.shields.io/badge/chat-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white&labelColor=black
[edge-store-link]: https://microsoftedge.microsoft.com/addons/detail/read-frog-open-source-a/cbcbomlgikfbdnoaohcjfledcoklcjbo
[edge-users-shield]: https://img.shields.io/badge/dynamic/json?style=flat-square&logo=microsoft-edge&label=Edge%20Users&query=%24.activeInstallCount&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fcbcbomlgikfbdnoaohcjfledcoklcjbo&labelColor=black
[edge-version-shield]: https://img.shields.io/badge/dynamic/json?style=flat-square&logo=microsoft-edge&label=Edge%20Version&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fcbcbomlgikfbdnoaohcjfledcoklcjbo&labelColor=black&prefix=v
[extension-release-shield]: https://img.shields.io/github/package-json/v/mengxi-ream/read-frog?filename=package.json&style=flat-square&label=Latest%20Version&color=brightgreen&labelColor=black
[github-release-link]: https://github.com/mengxi-ream/read-frog/releases
[github-star-link]: https://github.com/mengxi-ream/read-frog/stargazers
[image-banner]: /assets/store/large-promo-tile.png
[image-star]: ./assets/star.png
[issues-link]: https://github.com/mengxi-ream/read-frog/issues
[issues-shield]: https://img.shields.io/github/issues/mengxi-ream/read-frog?style=flat-square&labelColor=black
[last-commit-shield]: https://img.shields.io/github/last-commit/mengxi-ream/read-frog?style=flat-square&label=commit&labelColor=black
[sponsor-image]: https://cdn.jsdelivr.net/gh/mengxi-ream/static/sponsorkit/sponsors.svg
[sponsor-link]: https://github.com/sponsors/mengxi-ream
[sponsor-shield]: https://img.shields.io/github/sponsors/mengxi-ream?style=flat-square&label=Sponsor&color=EA4AAA&labelColor=black
[star-history-link]: https://www.star-history.com/#mengxi-ream/read-frog&Timeline
[star-history-shield]: https://img.shields.io/github/stars/mengxi-ream/read-frog?style=flat-square&label=stars&color=yellow&labelColor=black
[website]: https://readfrog.app
[wechat-link]: ./assets/wechat-account.jpg
[wechat-shield-badge]: https://img.shields.io/badge/chat-WeChat-07C160?style=for-the-badge&logo=wechat&logoColor=white&labelColor=black
