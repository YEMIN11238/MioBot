# Versioned Minecraft game facts

This is a small, offline derivative of the public PrismarineJS datasets. It contains Minecraft Java Edition **1.21.8**, not the Bedrock edition or a claim to support every Minecraft version.

- `minecraft-1.21.8.json`: 1,416 item records, 1,105 block records and 1,607 shaped/shapeless crafting recipe variants for 829 outputs.
- `PROVENANCE.json`: pinned package versions, snapshot SHA-256, transformation and scope.
- `upstream/`: unmodified package metadata and README notices supplied by the two upstream npm packages, plus the underlying data repository README (which also declares MIT and describes the data sources).
- `LICENSE`: retained license declarations, attribution and the standard MIT license terms. The upstream npm packages declare MIT in their `package.json`; neither package ships a separate LICENSE file.

The data does not describe the current player's inventory or world. Smelting, loot, trading, server status and game execution are not connected. A missing crafting recipe does not mean an item cannot be obtained in the game. Recipe quantity calculations count complete batches and direct ingredients only.

Sources:

- https://github.com/PrismarineJS/node-minecraft-data (`minecraft-data@3.119.0`, MIT)
- https://github.com/PrismarineJS/minecraft-data (underlying game data linked by node-minecraft-data)
- https://github.com/PrismarineJS/prismarine-recipe (`prismarine-recipe@1.5.0`, MIT)

To regenerate, create a temporary npm project, install exactly `minecraft-data@3.119.0 prismarine-recipe@1.5.0` with install scripts disabled, then run `node integrations/game-data/export-from-packages.mjs /absolute/path/to/that/temp-project`. Runtime does not need either npm package installed. Compare the generated dataset hash and run the game-tools tests before accepting an update.
