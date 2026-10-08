# Changelog

## 0.1.0 (2026-10-08)


### Features

* **clipact:** add dynamic shell completions for bash, zsh, and fish ([45f60a9](https://github.com/hugomrdias/fil/commit/45f60a9e7977188111f5215edaa938a504247bf1))
* **clipact:** add framework for agent-friendly CLIs ([cd39668](https://github.com/hugomrdias/fil/commit/cd396681f068c3721c6770c8bd43ed13356cc214))
* **clipact:** add skills install, status, and uninstall commands ([0570564](https://github.com/hugomrdias/fil/commit/05705645b38e84d8f383c61c940f43a7d6b269f9))
* **clipact:** data or error result envelope with an error registry ([#26](https://github.com/hugomrdias/fil/issues/26)) ([0f152ff](https://github.com/hugomrdias/fil/commit/0f152ff960d942b0492d307c44033d9e62115fba))
* **fil-cli:** prototype the Filecoin CLI (fil) on clipact with console login, single-copy storage, and resumable jobs ([#5](https://github.com/hugomrdias/fil/issues/5)) ([93de7a1](https://github.com/hugomrdias/fil/commit/93de7a106f262a50a873629f34afe28d0c29f2cf)), closes [#1](https://github.com/hugomrdias/fil/issues/1) [#2](https://github.com/hugomrdias/fil/issues/2) [#3](https://github.com/hugomrdias/fil/issues/3) [#4](https://github.com/hugomrdias/fil/issues/4)
* version packages and release them to npm with release-please ([#54](https://github.com/hugomrdias/fil/issues/54)) ([4bb7dce](https://github.com/hugomrdias/fil/commit/4bb7dce5c592efd11d6cc4036547215267afc7a3))


### Bug Fixes

* **clipact:** complete command paths from a declared built-in field ([bc35a84](https://github.com/hugomrdias/fil/commit/bc35a841282719b2d3bc32c39864c1681fad7b88))
* **clipact:** confine skill writes to the skill directory ([d88151d](https://github.com/hugomrdias/fil/commit/d88151d12f29899e4ec2ed9e109d80fe2e415848))
* **clipact:** define schema as a hidden built-in command so it accepts --help ([4a2bab3](https://github.com/hugomrdias/fil/commit/4a2bab3b3a686c46d03c709eb211031843c771bc))
* **clipact:** drop redundant dry-run line from help ([3f39e89](https://github.com/hugomrdias/fil/commit/3f39e89754bc6f7498d39ad4adc76f865f2fa790))
* **clipact:** harden input handling found by validating the example CLI ([93f9b5c](https://github.com/hugomrdias/fil/commit/93f9b5c03ad0a2505048da8e1dc770dd0aed8af6))
* **clipact:** keep acronyms as one word in flag names ([295e4b7](https://github.com/hugomrdias/fil/commit/295e4b7dd200c013556c82211d31f647f557482b))
* **clipact:** keep error results intact when data or serialization misbehave ([87321e5](https://github.com/hugomrdias/fil/commit/87321e5b11ff3505b35fb441dc3cda3b1afbcc55))
* **clipact:** make skill installs robust to read-only files and links ([bfed1ae](https://github.com/hugomrdias/fil/commit/bfed1ae0a264909f69e4b35b6dbfbdb9797e0f91))
* **clipact:** reject valued switches, decode split UTF-8, parse schema --format ([029ac18](https://github.com/hugomrdias/fil/commit/029ac18e2aa6235cca9f36e57ff6f150da80d3b6))
