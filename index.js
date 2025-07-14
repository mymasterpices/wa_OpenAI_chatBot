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
const MODEL = "gpt-4";              // Using GPT-4 model
const MAX_ROWS_TO_MODEL = 20;          // ★ hard cap
const userConversations = {};          // { phone : [ { role, content } ] }

// ─────────── Fixed Excel Loading with Error Handling ───────────
function loadProductData() {
  const filePath = path.join(__dirname, "uploads", "app-items.xlsx");
  if (!fs.existsSync(filePath)) {
    console.error("❌ Excel file not found:", filePath);
    return [];
  }

  try {
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);
    console.log(`✅ Loaded ${data.length} products from Excel`);
    return data;
  } catch (error) {
    console.error("❌ Error reading Excel file:", error);
    return [];
  }
}

const productData = loadProductData();

// ─────────── Fixed Filtering Logic ───────────
function filterProducts(query) {
  if (!productData || productData.length === 0) {
    console.error("❌ No product data available");
    return [];
  }

  const lower = query.toLowerCase();
  console.log(`🔍 Searching for: "${query}" in ${productData.length} products`);

  const results = productData.filter(p => {
    const category = (p["Product Category"] || "").toLowerCase();
    const subCategory = (p["Sub Category"] || "").toLowerCase();
    const collection = (p["Collection"] || "").toLowerCase();
    const style = (p["Style"] || "").toLowerCase();
    const goldPurity = (p["Gold Purity"] || "").toLowerCase();
    const gender = (p["Gender Name"] || "").toLowerCase();
    const jewelCode = (p["JewelCode"] || "").toLowerCase();
    const price = parseInt(p["Sale Price"], 10) || 0;

    // ✅ FIXED: Check if any product field contains the search query
    const hasKeyword = category.includes(lower) ||
      subCategory.includes(lower) ||
      collection.includes(lower) ||
      style.includes(lower) ||
      goldPurity.includes(lower) ||
      gender.includes(lower) ||
      jewelCode.includes(lower);

    // Handle price filters (under/over)
    const priceMatch = lower.match(/(under|over)\s*\u20B9?(\d+)/);
    if (priceMatch) {
      const num = parseInt(priceMatch[2], 10);
      return hasKeyword && (priceMatch[1] === "under" ? price <= num : price >= num);
    }

    return hasKeyword;
  });

  console.log(`📦 Found ${results.length} matching products`);
  return results;
}

function selectColumns(rows) {          // ★ keep only what GPT needs
  return rows.map(p => ({
    jewelCode: p["JewelCode"],
    category: p["Product Category"],
    subCategory: p["Sub Category"],
    collection: p["Collection"],
    style: p["Style"],
    goldPurity: p["Gold Purity"],
    price: p["Sale Price"],
    gender: p["Gender Name"],
    grossWt: p["Gross Wt"],
    netWt: p["Net Wt"],
    diamondWt: p["Dia Wt"],
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
-This GPT acts as a customer-facing assistant that responds on behalf of the business owner. It uses product data exported from SQL Server in Excel format—currently based on the file "app-items.xlsx"—and maps it to images or folders stored in Google Drive, based on naming conventions or product codes. The assistant uses the 'JewelCode' field as the SKU identifier when responding to product inquiries. It references the latest uploaded data (including "app-items.xlsx") to provide accurate product categories, subcategories, collections, styles, gold purity, prices, and availability. It can generate links to Google Drive images (if publicly accessible or with known link structure), or embed them directly if supported by the platform (e.g., WhatsApp). When using Google Drive image links, the assistant preserves the full URL from the 'Image URL' column—including any parameters like ?usp=drivesdk—to ensure correct embedding and access.

-The available product data includes: Product Category, Sub Category, Collection, JewelCode, Style, Gold Purity, Sale Price, Diamond Colour, Diamond Clarity, quality code, Gender Name, Qty, Gross Wt, Net Wt, Metal Amt, Dia Wt, Dia Amt, CS Wt, CS Amt, and Image URL. Use this comprehensive data to provide detailed product information to customers.

-Responses are short, friendly, and optimized for messaging platforms like WhatsApp. If a customer asks for a type of product, it analyzes the uploaded Excel product data, filters relevant entries based on Product Category, Sub Category, Collection, Style, Gold Purity, Gender Name, or JewelCode, and responds with embedded product images and brief highlights such as category, subcategory, style, gold purity, and price—never using raw data tables. When explaining price differences or product details, the assistant summarizes relevant attributes in plain language rather than displaying data tables.

-If a customer inquires about buyback, the assistant will respond only if a policy has been shared in the context. Otherwise, it will politely guide them to contact the RK Jewellers store directly. The assistant also maintains a memory of pinned notes for internal guidance and can recall or refer to them when needed.

-The assistant also includes essential brand information in its responses where relevant. The brand's official website is rkjewellers.in, with social presence on Instagram (instagram.com/rkjewellers_southex2), Facebook (facebook.com/zeljewellers), and YouTube (https://www.youtube.com/@RKJewellers). Although many shops share the name RK Jewellers across India and New Delhi, this assistant represents the one and only flagship store located in South Extension, New Delhi.

-The assistant strictly limits its responses to topics related to the uploaded product data, jewellery items, and the RK Jewellers brand. It does not respond to questions outside of this defined scope.

-IMPORTANT: When the getProducts function is called, you MUST use the provided product data to give specific product recommendations. Do not make up or generate random product information. Only use the actual products returned by the function.
`
};

const tools = [
  {
    type: "function",
    function: {
      name: "getProducts",
      description: "Retrieve products matching the user query from the catalog.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Product-related query" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "suggestFallback",
      description: "Retrieve top-3 suggestions when no exact match is found.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

// ─────────── WhatsApp helpers ───────────
async function sendWhatsApp(to, text) {
  try {
    return await axios.post(
      `https://graph.facebook.com/${process.env.VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, text: { body: text } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Error sending WhatsApp message:", err.response?.data || err.message);
    throw err;
  }
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
    // Don't throw error for image sending failures, just log it
  }
}

// ─────────── Webhook verification ───────────
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ─────────── Debug route for testing products ───────────
app.get("/test-products", (req, res) => {
  const query = req.query.q || "ring";
  const results = filterProducts(query);
  res.json({
    query,
    totalProducts: productData.length,
    matchingProducts: results.length,
    sampleData: productData.slice(0, 2),
    results: results.slice(0, 3)
  });
});

// ─────────── Webhook receiver ───────────
app.post("/webhook", async (req, res) => {
  try {
    // Add detailed logging of the incoming webhook
    console.log("📥 Incoming webhook payload:", JSON.stringify(req.body, null, 2));

    // Validate webhook structure
    if (!req.body?.entry?.[0]?.changes?.[0]?.value) {
      console.log("⚠️ Invalid webhook format: Missing entry or changes");
      return res.sendStatus(200);
    }

    const value = req.body.entry[0].changes[0].value;

    // Check if this is a status update (ignore these)
    if (value.statuses) {
      console.log("ℹ️ Received status update, ignoring");
      return res.sendStatus(200);
    }

    // Extract message details
    const msg = value.messages?.[0];
    if (!msg) {
      console.log("⚠️ No message found in webhook");
      return res.sendStatus(200);
    }

    const from = msg.from;
    const userQuery = msg.text?.body?.trim();

    // Validate required fields
    if (!from) {
      console.log("⚠️ Missing sender information");
      return res.sendStatus(200);
    }

    if (!userQuery) {
      console.log("⚠️ Missing or empty message text");
      return res.sendStatus(200);
    }

    console.log(`📨 Received message from ${from}: "${userQuery}"`);

    // Initialize conversation history if not exists
    if (!userConversations[from]) {
      userConversations[from] = [];
    }

    const history = userConversations[from].slice(-6); // Keep last 6 messages
    const messages = [systemPrompt, ...history, { role: "user", content: userQuery }];

    // ── First call to OpenAI ──
    const first = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto"
    });

    const choice = first.choices[0].message;
    let assistantResponse = "";
    let productsToSend = [];

    if (choice.tool_calls && choice.tool_calls.length > 0) {
      const toolCall = choice.tool_calls[0];
      const { name, arguments: argsJSON } = toolCall.function;
      let functionResult;

      console.log(`🔧 Function called: ${name} with args: ${argsJSON}`);

      if (name === "getProducts") {
        const { query } = JSON.parse(argsJSON);
        const allMatches = filterProducts(query);

        if (allMatches.length === 0) {
          functionResult = JSON.stringify({ message: "No products found matching your query." });
        } else {
          const matches = selectColumns(allMatches.slice(0, MAX_ROWS_TO_MODEL));
          functionResult = JSON.stringify({ products: matches });
          productsToSend = allMatches.slice(0, 3); // Always set products to send
        }
      } else if (name === "suggestFallback") {
        const fallback = selectColumns(topFallback());
        functionResult = JSON.stringify({ products: fallback });
        productsToSend = topFallback();
      }

      // Add function call and result to message history
      messages.push(choice);
      messages.push({
        role: "tool",
        content: functionResult,
        tool_call_id: toolCall.id
      });

      // ── Second call to OpenAI ──
      const second = await openai.chat.completions.create({ model: MODEL, messages });
      assistantResponse = second.choices[0].message.content.trim();

    } else {
      assistantResponse = choice.content?.trim() || "🙏 Sorry, I didn't understand that. Please ask about a product.";
    }

    console.log(`🤖 AI Response: "${assistantResponse}"`);
    console.log(`📦 Products to send: ${productsToSend.length}`);

    // ─────────── Send replies ───────────
    if (productsToSend.length) {
      // Send text response first
      await sendWhatsApp(from, assistantResponse);

      // Then send products with images
      for (const p of productsToSend) {
        const category = p["Product Category"] || "Jewelry";
        const subCategory = p["Sub Category"] || "";
        const collection = p["Collection"] || "";
        const price = p["Sale Price"] ? `₹${p["Sale Price"]}` : "Price not available";
        const jewelCode = p["JewelCode"] || "";
        const goldPurity = p["Gold Purity"] || "";
        const gender = p["Gender Name"] || "";
        const grossWt = p["Gross Wt"] || "";
        const netWt = p["Net Wt"] || "";

        let productText = `✨ *${category}`;
        if (subCategory) productText += ` - ${subCategory}`;
        productText += `*\n💰 ${price}`;
        if (jewelCode) productText += `\n🏷️ Code: ${jewelCode}`;
        if (goldPurity) productText += `\n⚡ Gold: ${goldPurity}`;
        if (gender) productText += `\n👤 Gender: ${gender}`;
        if (collection) productText += `\n💎 Collection: ${collection}`;
        if (grossWt) productText += `\n⚖️ Weight: ${grossWt}gm`;

        await sendWhatsApp(from, productText);

        // Send image if available
        if (p["Image URL"]) {
          const displayName = `${category}${subCategory ? ' - ' + subCategory : ''}`;
          await sendWhatsAppImage(from, p["Image URL"], displayName);
        }
      }
    } else {
      // Send only text response
      await sendWhatsApp(from, assistantResponse);
    }

    // ── Save conversation history (keep last 12 messages) ──
    userConversations[from].push({ role: "user", content: userQuery });
    userConversations[from].push({ role: "assistant", content: assistantResponse });
    userConversations[from] = userConversations[from].slice(-12);

    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error in webhook:", err);

    // Try to send error message to user
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await sendWhatsApp(from, "🙏 Sorry, I'm experiencing technical difficulties. Please try again in a moment.");
      }
    } catch (sendErr) {
      console.error("❌ Error sending error message:", sendErr);
    }

    res.sendStatus(500);
  }
});

// ─────────── Health check endpoint ───────────
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    productsLoaded: productData.length,
    toolsConfigured: tools.length,
    environment: {
      openaiConfigured: !!process.env.OPENAI_API_KEY,
      whatsappConfigured: !!process.env.WHATSAPP_TOKEN,
      phoneNumberId: !!process.env.PHONE_NUMBER_ID,
      verifyToken: !!process.env.VERIFY_TOKEN
    }
  });
});

// ─────────── Start server ───────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Expose with: ngrok http ${PORT}`);
  console.log(`📊 Loaded ${productData.length} products from Excel`);

  // Debug: Show first few products
  if (productData.length > 0) {
    console.log("📦 Sample products:");
    productData.slice(0, 3).forEach((p, i) => {
      console.log(`  ${i + 1}. ${p["Product Category"]} - ${p["Sub Category"]} - ₹${p["Sale Price"]} (${p["JewelCode"]})`);
    });
  } else {
    console.log("⚠️ No products loaded. Check if uploads/app-items.xlsx exists and has data.");
  }

  // Verify environment variables
  const requiredVars = ['OPENAI_API_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'VERSION'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.log(`⚠️ Missing environment variables: ${missingVars.join(', ')}`);
  } else {
    console.log("✅ All required environment variables are set");
  }
});
