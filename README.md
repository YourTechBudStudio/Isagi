# Isagi

`// a harness for the harness`

Isagi is a meta-harness for building systems that prompt coding agents for you. Its workflows handle prompts, handoffs, waits, and branching, while resumable worktree rooms keep each line of work focused.

It sits above the coding agents you already use instead of replacing them. You define the workflow; Isagi keeps the agents and their work organized around it. Nobody gets replaced here, least of all you.

## Why Isagi?

Isagi is a character from the anime _Blue Lock_ whose defining ability is spatial awareness. This tool works on the same idea: it understands what each agent is doing through workflows and gives that work a focused, organized room. That is where the name comes from.

Yes, it is an anime reference. It is also the most accurate description we had.

## Installation

Download the latest build for your platform:

| Platform              | Download                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS — Apple silicon | [DMG](https://github.com/YourTechBudStudio/Isagi/releases/latest/download/Isagi-mac-arm64.dmg)                                                                                                                        |
| macOS — Intel         | [DMG](https://github.com/YourTechBudStudio/Isagi/releases/latest/download/Isagi-mac-x64.dmg)                                                                                                                          |
| Linux — x86-64        | [AppImage](https://github.com/YourTechBudStudio/Isagi/releases/latest/download/Isagi-linux-x86_64.AppImage) · [installer](https://github.com/YourTechBudStudio/Isagi/releases/latest/download/install-isagi-linux.sh) |

### macOS

Download the DMG for your Mac, open it, and drag Isagi into Applications. The usual drag-into-the-folder ritual.

### Linux

Download the latest AppImage and installer, then run the installer as your normal user:

```sh
curl -fLO https://github.com/YourTechBudStudio/Isagi/releases/latest/download/Isagi-linux-x86_64.AppImage
curl -fLO https://github.com/YourTechBudStudio/Isagi/releases/latest/download/install-isagi-linux.sh
sh ./install-isagi-linux.sh
```

The installer registers Isagi with your application menu and places the AppImage in a user-writable location so automatic updates can replace it. Do not run it with `sudo` — an auto-updater that cannot write to its own binary is just a notification.

## Post-installation

Get the recommended workflows and agent skills from [`coding-harness-config`](https://github.com/YourTechBud/coding-harness-config), then follow that repository's setup instructions. Isagi runs without them; it is just quieter about what it can do.

## License

Except where otherwise noted, Isagi's original software and documentation are licensed under the [Apache License 2.0](./LICENSE).

The app logo files [`app-icon.png`](./apps/desktop/assets/app-icon.png) and [`app-icon-linux.png`](./apps/desktop/assets/app-icon-linux.png) are licensed separately under the [Creative Commons Attribution 4.0 International License](./apps/desktop/assets/LOGO-LICENSE.md). Bundled third-party materials retain the licenses identified alongside those materials.

`// built for developers who ship`
