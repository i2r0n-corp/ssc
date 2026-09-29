import requests, json

r = requests.get('https://ssc-catalog-cap-backend.cfapps.us10-001.hana.ondemand.com/api/catalog/getSnapshot', stream=True)
data = r.json()
flat_index = json.loads(data['payload'])['flat_index']

# Get first service
svc = next(iter(flat_index.values()))
print("=== SAMPLE SERVICE ===")
print(json.dumps({
    'code': svc.get('code'),
    'classificationFeatures': svc.get('classificationFeatures'),
    'supercategories': svc.get('supercategories', [])[:2]
}, indent=2))
