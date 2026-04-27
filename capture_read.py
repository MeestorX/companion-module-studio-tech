import json
with open("m370a gain and electret power with responses.json") as f:
    data = json.load(f)
print(json.dumps(data, indent=2))
