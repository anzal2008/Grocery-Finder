import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const baseUrl = "https://www.realcanadiansuperstore.ca";
const outputDir = new URL("./data/", import.meta.url);
const outputFile = new URL("superstore-prices.json", outputDir);
const tempFile = new URL("superstore-prices.json.tmp", outputDir);

const categories = {
  eggs: (name, unit) =>
    unit === "count" &&
    /\beggs?\b/i.test(name) &&
    !/boiled|peeled|chocolate|candy/i.test(name),

  rice: (name, unit) =>
    unit === "g" &&
    /\b(rice|basmati|jasmine|calrose|long grain|wholegrain brown)\b/i.test(name) &&
    !/fried rice|side dish|bistro express|ready to heat|cups|cakes|krispies|kimbap|flavou?r|cereal/i.test(name),

  butter: (name, unit) =>
    unit === "g" &&
    /\bbutter\b/i.test(name) &&
    !/plant|margarine|alternative|spread|canola|garlic|herb|sauce|chicken/i.test(name),

  beef: (name, unit) =>
    unit === "g" &&
    /\bground (?:halal )?(?:beef|sirloin)\b/i.test(name) &&
    !/pork|burgers?|patties|seasoning|meatballs|meal/i.test(name),
};

function parsePackage(packageSizing) {
  // Handles sizes such as "12 ea", "2 kg", and "4x113 g".
  const match = String(packageSizing ?? "").match(
    /^\s*(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|g|ea)\b/i,
  );

  if (!match) return null;

  const [, packCount, amount, rawUnit] = match;
  const unit = rawUnit.toLowerCase();
  const quantity = Number(packCount ?? 1) * Number(amount);

  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  return {
    packageQuantity: unit === "kg" ? quantity * 1000 : quantity,
    packageUnit: unit === "ea" ? "count" : "g",
  };
}

async function importCategory(category, matches) {
  const relativePath = `superstore-pages/${category}.html`;
  const pageFile = new URL(`./${relativePath}`, import.meta.url);

  let html;
  try {
    html = await readFile(pageFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing file: ${relativePath}`);
    }
    throw error;
  }

  const embedded = html.match(
    /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );

  if (!embedded) {
    throw new Error(`${relativePath}: no embedded product data. Save the page source again.`);
  }

  const pageData = JSON.parse(embedded[1]);
  const components =
    pageData.props?.pageProps?.initialSearchData?.layout?.sections
      ?.mainContentCollection?.components;

  const tiles = components?.flatMap(
    (component) => component.data?.productTiles ?? [],
  );

  if (!tiles?.length) {
    throw new Error(`${relativePath}: no products found. Save the search results page.`);
  }

  const products = new Map();

  for (const tile of tiles) {
    const id = tile.productId;
    const name = tile.title?.trim();
    const size = parsePackage(tile.packageSizing);
    const priceCad = Number(tile.pricing?.price);

    if (
      !id ||
      !name ||
      !size ||
      !matches(name, size.packageUnit) ||
      !Number.isFinite(priceCad) ||
      priceCad <= 0 ||
      tile.pricingUnits?.weighted ||
      !tile.link?.startsWith("/")
    ) {
      continue;
    }

    const sourceUrl = new URL(tile.link, baseUrl);
    if (sourceUrl.origin !== baseUrl) continue;

    const existing = products.get(id);
    if (existing && existing.priceCad <= priceCad) continue;

    const isWeight = size.packageUnit === "g";
    const unitPrice = (priceCad * (isWeight ? 100 : 1)) / size.packageQuantity;

    products.set(id, {
      id,
      name,
      brand: tile.brand?.trim() || null,
      ...size,
      priceCad,
      unitPriceCad: Number(unitPrice.toFixed(4)),
      unitPriceBasis: isWeight ? "per 100 g" : "per egg",
      sourceUrl: sourceUrl.href,
    });
  }

  const sorted = [...products.values()].sort(
    (a, b) => a.priceCad - b.priceCad || a.name.localeCompare(b.name),
  );

  if (!sorted.length) {
    throw new Error(`${relativePath}: no matching products with a fixed package size and price.`);
  }

  console.log(`${category}: kept ${sorted.length} of ${tiles.length} listings`);
  return [category, sorted];
}

async function main() {
  const results = await Promise.allSettled(
    Object.entries(categories).map(([category, matches]) =>
      importCategory(category, matches),
    ),
  );

  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length) {
    for (const failure of failures) console.error(failure.reason.message);
    console.error("Import incomplete. Any existing JSON was preserved.");
    process.exitCode = 1;
    return;
  }

  const snapshot = {
    importedAt: new Date().toISOString(),
    retailers: {
      superstore: {
        name: "Real Canadian Superstore",
        currency: "CAD",
        priceType: "Saved online listings; Vancouver branch prices unverified",
        categories: Object.fromEntries(results.map((result) => result.value)),
      },
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(tempFile, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  await rename(tempFile, outputFile);

  console.log("Saved data/superstore-prices.json");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});