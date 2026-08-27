from replit.object_storage import Client
from pathlib import Path
import json

client = Client()

output = Path("replit_visual_backup/app_storage")
output.mkdir(parents=True, exist_ok=True)

objects = client.list()

manifest = []

print(f"Found {len(objects)} App Storage objects.")

for i, obj in enumerate(objects, 1):
    name = obj.name

    destination = output / name
    destination.parent.mkdir(parents=True, exist_ok=True)

    print(f"[{i}/{len(objects)}] {name}")

    client.download_to_filename(name, str(destination))
    manifest.append(name)

with open(output / "manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)

print("")
print("DONE")
print(f"Downloaded {len(objects)} objects to:")
print(output)
