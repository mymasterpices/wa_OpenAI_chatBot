const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const xlsx = require("xlsx");
const { OpenAI } = require("openai");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static("public"));

// ─────────── OpenAI ───────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o";              // ★ higher rate-limit than gpt-4
const MAX_ROWS_TO_MODEL = 20;          // ★ hard cap
const userConversations = {};          // { phone : [ { role, content } ] }

// ─────────── Load Excel once ───────────
function loadProductData() {
  const filePath = path.join(__dirname, "uploads", "app-items.xlsx");
  if (!fs.existsSync(filePath)) return [];
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet);
}
const productData = loadProductData();

// ─────────── Helpers ───────────
function filterProducts(query) {
  const lower = query.toLowerCase();
  return productData.filter(p => {
    const name = (p["Product Name"] || "").toLowerCase();
    const cat = (p["Category"] || "").toLowerCase();
    const price = parseInt(p["Price"], 10);
    const hasKeyword = lower.includes(name) || lower.includes(cat);

    const m = lower.match(/(under|over)\s*\u20B9?(\d+)/);
    if (m) {
      const num = parseInt(m[2], 10);
      return hasKeyword && (m[1] === "under" ? price <= num : price >= num);
    }
    return hasKeyword;
  });
}

function selectColumns(rows) {          // ★ keep only what GPT needs
  return rows.map(p => ({
    sku: p["Jewel Code"],
    name: p["Product Name"],
    price: p["Price"],
    img: p["Image URL"]
  }));
}

function topFallback() {
  return productData.slice(0, 3);
}

// ─────────── Prompts ───────────
const systemPrompt = {
  role: "system",
  content: `
-This GPT acts as a customer-facing assistant that responds on behalf of the business owner. It uses product data exported from SQL Server in Excel format—currently based on the file \"app-items.xlsx\"—and maps it to images or folders stored in Google Drive, based on naming conventions or product codes. The assistant uses the 'Jewel Code' field as the SKU identifier when responding to product inquiries. It references the latest uploaded data (including \"app-items.xlsx\") to provide accurate product names, prices, and availability. It can generate links to Google Drive images (if publicly accessible or with known link structure), or embed them directly if supported by the platform (e.g., WhatsApp). When using Google Drive image links, the assistant preserves the full URL from the 'Image URL' column—including any parameters like ?usp=drivesdk—to ensure correct embedding and access.

-Responses are short, friendly, and optimized for messaging platforms like WhatsApp. If a customer asks for a type of product, it analyzes the uploaded Excel product data, filters relevant entries, and responds with embedded product images and brief highlights such as product name and price—never using raw data tables. When explaining price differences or product details, the assistant summarizes relevant attributes in plain language rather than displaying data tables.

-If a customer inquires about buyback, the assistant will respond only if a policy has been shared in the context. Otherwise, it will politely guide them to contact the RK Jewellers store directly. The assistant also maintains a memory of pinned notes for internal guidance and can recall or refer to them when needed.

-The assistant also includes essential brand information in its responses where relevant. The brand's official website is rkjewellers.in, with social presence on Instagram (instagram.com/rkjewellers_southex2), Facebook (facebook.com/zeljewellers), and YouTube (https://www.youtube.com/@RKJewellers). Although many shops share the name RK Jewellers across India and New Delhi, this assistant represents the one and only flagship store located in South Extension, New Delhi.

-The assistant strictly limits its responses to topics related to the uploaded product data, jewellery items, and the RK Jewellers brand. It does not respond to questions outside of this defined scope.
`
};

const functions = [
  {
    name: "getProducts",
    description: "Retrieve products matching the user query from the catalog.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Product-related query" } },
      required: ["query"]
    }
  },
  {
    name: "suggestFallback",
    description: "Retrieve top-3 suggestions when no exact match is found.",
    parameters: { type: "object", properties: {}, required: [] }
  }
];

// ─────────── WhatsApp helpers ───────────
async function sendWhatsApp(to, text) {
  return axios.post(
    `https://graph.facebook.com/${process.env.VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendWhatsAppImage(to, link, caption = "") {
  try {
    return await axios.post(
      `https://graph.facebook.com/${process.env.VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "image", image: { link, caption } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Error sending image:", err.response?.data || err.message);
  }
}

// ─────────── Webhook verification ───────────
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// ─────────── Webhook receiver ───────────
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = msg?.from;
    const userQuery = msg?.text?.body?.trim();
    if (!from || !userQuery) return res.sendStatus(200);

    if (!userConversations[from]) userConversations[from] = [];
    const history = userConversations[from].slice(-6);

    const messages = [systemPrompt, ...history, { role: "user", content: userQuery }];

    // ── First call ──
    const first = await openai.chat.completions.create({ model: MODEL, messages, functions, function_call: "auto" });

    const choice = first.choices[0].message;
    let assistantResponse = "";
    let productsToSend = [];

    if (choice.function_call) {
      const { name, arguments: argsJSON } = choice.function_call;
      let functionResult;

      if (name === "getProducts") {
        const { query } = JSON.parse(argsJSON);
        const allMatches = filterProducts(query);

        if (allMatches.length > MAX_ROWS_TO_MODEL) {
          functionResult = JSON.stringify({ count: allMatches.length });
        } else {
          const matches = selectColumns(allMatches.slice(0, MAX_ROWS_TO_MODEL));
          functionResult = JSON.stringify({ products: matches });
          productsToSend = allMatches.slice(0, 3);
        }
      } else if (name === "suggestFallback") {
        const fallback = selectColumns(topFallback());
        functionResult = JSON.stringify({ products: fallback });
        productsToSend = topFallback();
      }

      messages.push(choice);
      messages.push({ role: "function", name, content: functionResult });

      // ── Second call ──
      const second = await openai.chat.completions.create({ model: MODEL, messages });
      assistantResponse = second.choices[0].message.content.trim();

    } else {
      assistantResponse = choice.content?.trim() || "🙏 Sorry, I didn't understand that. Please ask about a product.";
    }

    // ─────────── Send replies ───────────
    if (productsToSend.length) {
      for (const p of productsToSend) {
        const name = p["Product Name"] || "Unnamed Product";
        const price = p["Price"] ? `₹${p["Price"]}` : "Price not available";
        const desc = p["Description"] || "";
        const text = `✨ *${name}*\n💰 ${price}\n${desc}`;
        await sendWhatsApp(from, text);
        if (p["Image URL"]) await sendWhatsAppImage(from, p["Image URL"], name);
      }
    } else {
      await sendWhatsApp(from, assistantResponse);
    }

    // ── Save trimmed conversation ──
    userConversations[from].push({ role: "user", content: userQuery });
    userConversations[from].push({ role: "assistant", content: assistantResponse });
    userConversations[from] = userConversations[from].slice(-12);

    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error in webhook:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Expose with: ngrok http ${PORT}`);
});
