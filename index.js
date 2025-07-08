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

// OpenAI setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const userConversations = {}; // { phoneNumber: [ { role, content } ] }

// Load Excel product data
function loadProductData() {
  const filePath = path.join(__dirname, "uploads", "product-data.xlsx");
  if (!fs.existsSync(filePath)) return [];
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet);
}
const productData = loadProductData();

function filterProducts(query) {
  const lower = query.toLowerCase();
  return productData.filter(p => {
    const name = (p["Product Name"] || "").toLowerCase();
    const cat = (p["Category"] || "").toLowerCase();
    const price = parseInt(p["Price"], 10);
    const hasKeyword = lower.includes(name) || lower.includes(cat);
    const m = lower.match(/(under|over)\s*₹?(\d+)/);
    if (m) {
      const num = parseInt(m[2], 10);
      return hasKeyword && (m[1] === "under" ? price <= num : price >= num);
    }
    return hasKeyword;
  });
}

function topFallback() {
  return productData.slice(0, 3);
}

const systemPrompt = {
  role: "system",
  content: `
You are an AI assistant for a luxury jewellery brand. Your job is to:
- Understand natural language
- Recommend jewellery from a product list
- Include product name, price, and image link
- Never make up products
- Answer politely, like a knowledgeable store assistant
- If no exact match, say "We don't have exact matching products, but here are a few similar products that you might like", then suggest top-3 similar products
- If out of scope, say "🙏 Sorry, I only handle questions about our jewellery products. Please ask about a product name, category, or price (e.g. under ₹5000). You can also visit our website to place an order: www.rkjewellers.in"
- Always respond in a friendly, helpful tone
- Always respond to greeting messages like "Hello", "Hi", "Hey" with a friendly greeting message
- Always respond to goodbye messages like "Bye", "Goodbye", "See you later" with a friendly goodbye message
`
};

const functions = [
  {
    name: "getProducts",
    description: "Retrieve products matching the user query from the catalog.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's product-related query." }
      },
      required: ["query"]
    }
  },
  {
    name: "suggestFallback",
    description: "Retrieve top-3 product suggestions when no exact match is found.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

async function sendWhatsApp(to, text) {
  return axios.post(
    `https://graph.facebook.com/${process.env.VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    console.log("WEBHOOK_VERIFIED");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Webhook receiver
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = msg?.from;
    const userQuery = msg?.text?.body?.trim();
    if (!from || !userQuery) return res.sendStatus(200);

    if (!userConversations[from]) userConversations[from] = [];

    const history = userConversations[from].slice(-6);
    const messages = [
      systemPrompt,
      ...history,
      { role: "user", content: userQuery }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
      functions,
      function_call: "auto"
    });

    const choice = completion.choices[0].message;

    let assistantResponse;

    if (choice.function_call) {
      const { name, arguments: argsJSON } = choice.function_call;
      let functionResult;

      if (name === "getProducts") {
        const { query } = JSON.parse(argsJSON);
        const matches = filterProducts(query);
        functionResult = JSON.stringify({ products: matches }, null, 2);
      } else if (name === "suggestFallback") {
        const fallback = topFallback();
        functionResult = JSON.stringify({ products: fallback }, null, 2);
      }

      messages.push(choice);
      messages.push({
        role: "function",
        name,
        content: functionResult
      });

      const second = await openai.chat.completions.create({
        model: "gpt-4",
        messages
      });

      assistantResponse = second.choices[0].message.content.trim();

    } else {
      // Allow GPT to respond freely (e.g. for greetings or farewells)
      assistantResponse = choice.content?.trim() ||
        "🙏 Sorry, I didn't understand that. Please ask about a product.";
    }

    userConversations[from].push({ role: "user", content: userQuery });
    userConversations[from].push({ role: "assistant", content: assistantResponse });

    if (userConversations[from].length > 12) {
      userConversations[from] = userConversations[from].slice(-12);
    }

    await sendWhatsApp(from, assistantResponse);
    res.sendStatus(200);

  } catch (err) {
    console.error("Error in webhook:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Expose with: ngrok http ${PORT}`);
});
