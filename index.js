const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const xlsx = require("xlsx");
const { OpenAI } = require("openai");
const axios = require("axios");
const rateLimit = require('express-rate-limit');
require("dotenv").config();

// ═══════════════════════════════════════════════════════════════════════════════
// 🔧 APP INITIALIZATION & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static("public"));

// Rate Limiting
const webhookLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/webhook', webhookLimiter);

// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 OPENAI CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o";
const MAX_ROWS_TO_MODEL = 20;
const userConversations = {}; // { phone : [ { role, content } ] }
const userProductResults = {}; // Store search results for pagination: { phone: { products: [], currentIndex: 0 } }

// System Prompt
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

// OpenAI Tools Configuration
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

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 PRODUCT DATA MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// Load Product Data from Excel
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

// Filter Products by Query
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

    // Check if any product field contains the search query
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

// Select Required Columns for AI Processing
function selectColumns(rows) {
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

// Get Top 3 Fallback Products
function topFallback() {
  return productData.slice(0, 3);
}

// Initialize Product Data
const productData = loadProductData();

// ═══════════════════════════════════════════════════════════════════════════════
// 📱 WHATSAPP API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// Send WhatsApp Text Message
async function sendWhatsApp(to, text) {
  try {
    // Ensure text is not empty and is a string
    if (!text || typeof text !== 'string') {
      console.error("❌ Invalid text message:", text);
      return;
    }

    // Ensure phone number is properly formatted (should start with country code)
    if (!to || !to.match(/^\d+$/)) {
      console.error("❌ Invalid phone number format:", to);
      return;
    }

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "text",
      text: {
        preview_url: true,
        body: text.substring(0, 4096) // WhatsApp has a 4096 character limit
      }
    };

    const response = await axios.post(
      `https://graph.facebook.com/${process.env.VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("✅ Message sent successfully:", response.data);
    return response;
  } catch (err) {
    console.error("❌ Error sending WhatsApp message:", err.response?.data || err.message);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 🧠 AI MESSAGE PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

// Process User Message with AI
async function processUserMessage(from, userQuery) {
  try {
    // Initialize conversation history if not exists
    if (!userConversations[from]) {
      userConversations[from] = [];
    }

    const history = userConversations[from].slice(-6); // Keep last 6 messages
    const messages = [systemPrompt, ...history, { role: "user", content: userQuery }];

    // First call to OpenAI
    const first = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto"
    });

    const choice = first.choices[0].message;
    let assistantResponse = "";
    let productsToSend = [];

    // Check if user is asking for more products
    const askingForMore = userQuery.toLowerCase().match(/more|next|show more|continue|additional/);

    if (askingForMore && userProductResults[from]) {
      // User is asking for more products and has previous results
      const { products, currentIndex } = userProductResults[from];
      if (currentIndex < products.length) {
        const nextBatch = products.slice(currentIndex, currentIndex + 3);
        productsToSend = nextBatch;
        userProductResults[from].currentIndex += 3;

        const remaining = products.length - (currentIndex + 3);
        assistantResponse = `Here are more products! ${remaining > 0 ? `\n\nThere are ${remaining} more items available. Type "show more" to see more products.` : '\n\nThat\'s all the products we have!'}`;

        // Skip OpenAI call since we're just showing more products
        return await sendMessageResponses(from, assistantResponse, productsToSend);
      } else {
        assistantResponse = "I've shown you all the available products. Would you like to search for something else?";
        return await sendWhatsApp(from, assistantResponse);
      }
    }

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
          // Clear stored results for this user
          delete userProductResults[from];
        } else {
          const matches = selectColumns(allMatches.slice(0, MAX_ROWS_TO_MODEL));
          functionResult = JSON.stringify({ products: matches });
          productsToSend = allMatches.slice(0, 3);

          // Store all results for pagination
          userProductResults[from] = {
            products: allMatches,
            currentIndex: 3
          };

          // Add information about remaining products
          if (allMatches.length > 3) {
            functionResult = JSON.stringify({
              products: matches,
              remaining: allMatches.length - 3
            });
          }
        }
      } else if (name === "suggestFallback") {
        const fallback = selectColumns(topFallback());
        functionResult = JSON.stringify({ products: fallback });
        productsToSend = topFallback();
        // Clear stored results for fallback
        delete userProductResults[from];
      }

      // Add function call and result to message history
      messages.push(choice);
      messages.push({
        role: "tool",
        content: functionResult,
        tool_call_id: toolCall.id
      });

      // Second call to OpenAI
      const second = await openai.chat.completions.create({ model: MODEL, messages });
      assistantResponse = second.choices[0].message.content.trim();

      // Add information about more products if available
      if (userProductResults[from] && userProductResults[from].products.length > 3) {
        const remaining = userProductResults[from].products.length - 3;
        assistantResponse += `\n\nI found ${remaining} more items matching your search. Type "show more" to see more products.`;
      }

    } else {
      if (askingForMore) {
        assistantResponse = "Please search for products first before asking to see more.";
      } else {
        assistantResponse = choice.content?.trim() || "🙏 Sorry, I didn't understand that. Please ask about a product.";
      }
    }

    console.log(`🤖 AI Response: "${assistantResponse}"`);
    console.log(`📦 Products to send: ${productsToSend.length}`);

    // Send replies to user
    await sendMessageResponses(from, assistantResponse, productsToSend);

    // Save conversation history (keep last 12 messages)
    userConversations[from].push({ role: "user", content: userQuery });
    userConversations[from].push({ role: "assistant", content: assistantResponse });
    userConversations[from] = userConversations[from].slice(-12);

  } catch (err) {
    console.error("❌ Error processing user message:", err);
    await sendWhatsApp(from, "🙏 Sorry, I encountered an error processing your message. Please try again.");
  }
}

// Send Message Responses (Text + Products)
async function sendMessageResponses(from, assistantResponse, productsToSend) {
  if (productsToSend.length) {
    // Send text response first
    await sendWhatsApp(from, assistantResponse);

    // Then send products with images
    for (const p of productsToSend) {
      const category = p["Product Category"] || "Jewelry";
      const subCategory = p["Sub Category"] || "";
      const collection = p["Collection"] || "";
      const style = p["Style"] || "";
      const price = p["Sale Price"] ? `₹${p["Sale Price"]}` : "Price not available";
      const jewelCode = p["JewelCode"] || "";
      const goldPurity = p["Gold Purity"] || "";
      const gender = p["Gender Name"] || "";
      const grossWt = p["Gross Wt"] || "";

      let productText = `✨ *${category}`;
      if (subCategory) productText += ` - ${subCategory}`;
      productText += `*\n💰 ${price}`;
      if (jewelCode) productText += `\n🏷️ Code: ${jewelCode}`;
      if (style) productText += `\n🎨 Style: ${style}`;
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
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Webhook Verification (GET)
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

// Webhook Message Receiver (POST)
app.post("/webhook", async (req, res) => {
  try {
    // Optional debug logging
    if (process.env.DEBUG === 'true') {
      console.log("📥 Full webhook payload:", JSON.stringify(req.body, null, 2));
    }

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Handle different webhook event types
    if (!entry || !changes || !value) {
      console.log("⚠️ Not a valid webhook entry structure");
      return res.sendStatus(200);
    }

    // Check for messages
    if (value.messages && value.messages.length > 0) {
      const msg = value.messages[0];
      const from = msg.from;

      // Only process text messages
      if (msg.type !== "text") {
        console.log(`⚠️ Unsupported message type: ${msg.type} from ${from}`);
        if (from) {
          await sendWhatsApp(from, "I can only process text messages at the moment. Please send me a text message about jewelry products.");
        }
        return res.sendStatus(200);
      }

      const userQuery = msg.text?.body?.trim();

      if (!from || !userQuery) {
        console.log("⚠️ Missing sender or message text");
        return res.sendStatus(200);
      }

      console.log(`📨 Processing text message from ${from}: "${userQuery}"`);

      // Process the message
      await processUserMessage(from, userQuery);

    } else if (value.statuses && value.statuses.length > 0) {
      // Handle status updates (delivery, read receipts, etc.)
      const status = value.statuses[0];
      console.log(`📋 Status update: ${status.status} for message ${status.id}`);

    } else {
      console.log("⚠️ Unknown webhook event type:", Object.keys(value));
    }

    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error in webhook:", err);

    // Try to send error message to user if we can identify them
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

// ═══════════════════════════════════════════════════════════════════════════════
// 🔧 UTILITY & DEBUG ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Health Check Endpoint
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

// Test Products Endpoint
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

// Debug Webhook Data
app.post("/webhook-debug", (req, res) => {
  console.log("🔍 Debug webhook data:");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));
  res.json({ received: true, body: req.body });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

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
