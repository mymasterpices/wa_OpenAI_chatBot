require('dotenv').config(); // Load environment variables
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getChatCompletion(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    console.log(completion.choices[0].message.content);
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
  }
}

getChatCompletion("ai integration with whatsapp bot using node js and openaiapi code, no third party applications, only node js and openai api");
