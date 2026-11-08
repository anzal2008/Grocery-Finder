import firebase_admin
from firebase_admin import credentials, firestore

# --- CONFIGURATION ---
FIREBASE_KEY_PATH = 'firebase-key.json'
TARGET_INGREDIENT_COUNT = 400

# Obvious outliers to remove immediately before we calculate the top 400
FANCY_AND_UNCOMMON_KEYWORDS = [
    'achiote', 'ackee', 'alinos', 'ancho', 'artichoke', 'barramundi', 
    'birds-eye', 'black pudding', 'black treacle', 'bryndza', 'casabe', 
    'cassaba', 'caviar', 'codfish bulljaw', 'conchs', 'duck', 
    'feather blade', 'filet mignon', 'frogs leg', 'galangal', 'gold leaf', 
    'goose fat', 'gruyere', 'gruyère', 'herbes de provence', 'ibérico', 
    'kabanos', 'kampot', 'khus khus', 'lobster', 'monkfish', 'morcilla', 
    'mulukhiyah', 'oyster', 'paccheri', 'pancetta', 'panquehue', 'parma ham', 
    'peach schnapps', 'pigs trotter', 'prahok', 'prosciutto', 'pul biber', 
    'ras el hanout', 'saffron', 'salt cod', 'scallop', 'serrano', 
    'sirop de liège', 'truffle', 'veal', 'venison', 'västerbottensost', 
    'wagyu', 'yautia', 'brie', 'charlotte potatoes', 'jersey royal potatoes'
]

SPICE_KEYWORDS = [
    'spice', 'seasoning', 'powder', 'cumin', 'paprika', 'coriander', 
    'turmeric', 'cardamom', 'clove', 'nutmeg', 'cinnamon', 'cayenne', 
    'chili', 'chilli', 'garam masala', 'curry', 'flake', 'oregano', 'thyme',
    'allspice', 'cajun', 'fennel seed', 'fenugreek', 'harissa', 'juniper', 
    'peppercorn', 'star anise', 'sumac', 'sichuan', 'szechuan'
]
MAX_SPICES_PER_RECIPE = 4

print("Connecting to Firestore...")
cred = credentials.Certificate(FIREBASE_KEY_PATH)
if not firebase_admin._apps:
    firebase_admin.initialize_app(cred)
db = firestore.client()

def filter_to_target():
    print("Fetching all recipes...")
    docs = db.collection('recipes').stream()
    
    all_recipes = {}
    
    # PASS 1: Read all recipes
    for doc in docs:
        all_recipes[doc.id] = doc.to_dict()

    recipes_to_delete = []
    tentative_recipes = {}

    # PASS 2: Initial filtering for obvious fancy items & too many spices
    for doc_id, data in all_recipes.items():
        title = data.get('title', 'Unknown Recipe')
        ingredients = data.get('ingredients', [])
        
        delete_reason = None
        spice_count = 0
        
        for item in ingredients:
            name = item.get('name', '').strip().lower()
            if any(fancy in name for fancy in FANCY_AND_UNCOMMON_KEYWORDS):
                delete_reason = f"Contains fancy keyword ({name})"
                break
            if any(spice in name for spice in SPICE_KEYWORDS):
                spice_count += 1
                
        if not delete_reason and spice_count > MAX_SPICES_PER_RECIPE:
            delete_reason = f"Too many spices ({spice_count})"
            
        if delete_reason:
            recipes_to_delete.append((doc_id, title, delete_reason))
        else:
            tentative_recipes[doc_id] = data

    # PASS 3: Calculate frequencies of the surviving recipes
    ingredient_freq = {}
    for data in tentative_recipes.values():
        for item in data.get('ingredients', []):
            name = item.get('name', '').strip().lower()
            if name:
                ingredient_freq[name] = ingredient_freq.get(name, 0) + 1

    # Isolate the Top 400 ingredients
    sorted_by_freq = sorted(ingredient_freq.items(), key=lambda x: x[1], reverse=True)
    top_ingredients = {name for name, count in sorted_by_freq[:TARGET_INGREDIENT_COUNT]}
    
    final_surviving_ingredients = set()

    # PASS 4: Delete any recipe that uses an ingredient NOT in the Top 400
    for doc_id, data in tentative_recipes.items():
        title = data.get('title', 'Unknown')
        ingredients = data.get('ingredients', [])
        
        uses_rare_ingredient = False
        for item in ingredients:
            name = item.get('name', '').strip().lower()
            if name and name not in top_ingredients:
                recipes_to_delete.append((doc_id, title, f"Uses non-top-400 ingredient ({name})"))
                uses_rare_ingredient = True
                break
                
        if not uses_rare_ingredient:
            # Add to our final text file list
            for item in ingredients:
                name = item.get('name', '').strip().lower()
                if name:
                    final_surviving_ingredients.add(name)

    # PASS 5: Execute Deletions in Firestore
    print(f"\nFound {len(recipes_to_delete)} total recipes to delete to hit targets.")
    for doc_id, title, reason in recipes_to_delete:
        print(f"Deleting '{title}' -> Reason: {reason}")
        db.collection('recipes').document(doc_id).delete()

    # PASS 6: Save the final ~400 list
    final_list_sorted = sorted(list(final_surviving_ingredients))
    with open('ingredients_list.txt', 'w', encoding='utf-8') as f:
        for ing in final_list_sorted:
            f.write(ing + '\n')
            
    print(f"\n--- Cleanup Complete ---")
    print(f"Original Recipes: {len(all_recipes)}")
    print(f"Deleted Recipes: {len(recipes_to_delete)}")
    print(f"Remaining Recipes: {len(all_recipes) - len(recipes_to_delete)}")
    print(f"Final Ingredient Count: {len(final_list_sorted)} (Target was {TARGET_INGREDIENT_COUNT})")

if __name__ == "__main__":
    filter_to_target()