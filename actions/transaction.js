"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

// Create Transaction
export async function createTransaction(data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    // Get request data for ArcJet
    const req = await request();

    // Check rate limit
    const decision = await aj.protect(req, {
      userId,
      requested: 1, // Specify how many tokens to consume
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });

        throw new Error("Too many requests. Please try again later.");
      }

      throw new Error("Request blocked");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const account = await db.account.findUnique({
      where: {
        id: data.accountId,
        userId: user.id,
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    // Calculate new balance
    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;

    // Create transaction and update account balance
    const transaction = await db.$transaction(async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          ...data,
          userId: user.id,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: newBalance },
      });

      return newTransaction;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getTransaction(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findUnique({
    where: {
      id,
      userId: user.id,
    },
  });

  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Get original transaction to calculate balance change
    const originalTransaction = await db.transaction.findUnique({
      where: {
        id,
        userId: user.id,
      },
      include: {
        account: true,
      },
    });

    if (!originalTransaction) throw new Error("Transaction not found");

    // Calculate balance changes
    const oldBalanceChange =
      originalTransaction.type === "EXPENSE"
        ? -originalTransaction.amount.toNumber()
        : originalTransaction.amount.toNumber();

    const newBalanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netBalanceChange = newBalanceChange - oldBalanceChange;

    // Update transaction and account balance in a transaction
    const transaction = await db.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: {
          id,
          userId: user.id,
        },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      // Update account balance
      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: netBalanceChange,
          },
        },
      });

      return updated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Get User Transactions
export async function getUserTransactions(query = {}) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const transactions = await db.transaction.findMany({
      where: {
        userId: user.id,
        ...query,
      },
      include: {
        account: true,
      },
      orderBy: {
        date: "desc",
      },
    });

    return { success: true, data: transactions };
  } catch (error) {
    throw new Error(error.message);
  }
}

// List available Gemini models
export async function listGeminiModels() {
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    // Make a direct API call to list models
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?key=" + process.env.GEMINI_API_KEY
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error listing models:", error);
    return { error: error.message };
  }
}

// Scan Receipt - Updated with only available models
export async function scanReceipt(formData) {
  try {
    // Get the file from formData
    const file = formData.get('file');
    
    if (!file) {
      throw new Error("No file provided");
    }

    // Check file size (5MB limit)
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("File size should be less than 5MB");
    }

    // Check if GEMINI_API_KEY is configured
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured in environment variables");
    }

    // Get the list of valid categories from the data file
    const { defaultCategories } = await import('@/data/categories');
    const validExpenseCategories = defaultCategories
      .filter(cat => cat.type === 'EXPENSE')
      .map(cat => cat.id)
      .join(',');

    // Simplified prompt for better compatibility
    const prompt = `Extract receipt information in this JSON format:
{
  "amount": 29.99,
  "date": "2023-12-25T00:00:00.000Z",
  "description": "Grocery shopping",
  "merchantName": "Store Name",
  "category": "groceries"
}

Use these categories: ${validExpenseCategories}

If not a receipt, return:
{
  "amount": 0,
  "date": "${new Date().toISOString()}",
  "description": "Not a receipt",
  "merchantName": "Unknown",
  "category": "other-expense"
}`;

    // Convert File to ArrayBuffer
    const bytes = await file.arrayBuffer();
    const base64String = Buffer.from(bytes).toString("base64");

    // Try different endpoints with available models (only the working ones)
    const endpointsToTry = [
      // Newer models first (based on the API response)
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-002:generateContent",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-002:generateContent",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-03-25:generateContent"
    ];

    let apiResponse = null;
    let lastError = null;

    // Try each endpoint until one works
    for (const endpoint of endpointsToTry) {
      try {
        console.log(`Trying endpoint: ${endpoint}`);
        const response = await fetch(
          `${endpoint}?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      inlineData: {
                        mimeType: file.type,
                        data: base64String,
                      },
                    },
                    {
                      text: prompt,
                    },
                  ],
                },
              ],
            }),
          }
        );

        if (response.ok) {
          apiResponse = await response.json();
          console.log(`Endpoint ${endpoint} succeeded`);
          break;
        } else {
          const errorText = await response.text();
          console.log(`Endpoint ${endpoint} failed:`, errorText);
          lastError = new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
        }
      } catch (error) {
        console.log(`Endpoint ${endpoint} failed with exception:`, error.message);
        lastError = error;
      }
    }

    // If all endpoints failed, provide a more user-friendly fallback
    if (!apiResponse && lastError) {
      console.error("All endpoints failed:", lastError);
      throw lastError;
    }

    // Extract the text response
    const text = apiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log("Extracted text:", text);

    // Extract JSON from the response
    let jsonString = text.trim();
    
    // Remove markdown code blocks
    jsonString = jsonString.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, "$1").trim();
    
    // Find JSON object in the response
    const jsonStart = jsonString.indexOf('{');
    const jsonEnd = jsonString.lastIndexOf('}');
    
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      jsonString = jsonString.substring(jsonStart, jsonEnd + 1);
    }
    
    console.log("Extracted JSON string:", jsonString);

    try {
      const data = JSON.parse(jsonString);
      
      // Validate and sanitize the data
      const amount = typeof data.amount === 'number' ? Math.abs(data.amount) : 0;
      const date = data.date ? new Date(data.date) : new Date();
      const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : "Receipt scan";
      const merchantName = typeof data.merchantName === 'string' && data.merchantName.trim() ? data.merchantName.trim() : "Unknown merchant";
      
      // Validate category against allowed values
      let category = "other-expense";
      const validCategoryList = validExpenseCategories.split(',');
      if (data.category && validCategoryList.includes(data.category)) {
        category = data.category;
      }
      
      console.log("Successfully parsed and validated data:", { amount, date, description, merchantName, category });
      
      return {
        amount,
        date,
        description,
        merchantName,
        category
      };
    } catch (parseError) {
      console.error("JSON parsing failed:", parseError);
      console.error("Attempted to parse:", jsonString);
      
      // Return default values when parsing fails
      return {
        amount: 0,
        date: new Date(),
        description: "Receipt scan - AI response format not recognized. Please manually enter details.",
        merchantName: "Unknown merchant",
        category: "other-expense"
      };
    }
  } catch (error) {
    console.error("Receipt scanning failed:", error);
    
    // Return user-friendly error information
    return {
      amount: 0,
      date: new Date(),
      description: `Error: ${error.message}. Please manually enter receipt details.`,
      merchantName: "Error occurred",
      category: "other-expense"
    };
  }
}

// Test Gemini API connectivity
export async function testGeminiAPI() {
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    // Try different models
    const modelsToTry = [
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-pro-vision"
    ];

    let workingModel = null;
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent("Say 'API test successful' in JSON format: {\"status\": \"success\", \"message\": \"API test successful\"}");
        const response = await result.response;
        const text = response.text();
        
        // Try to parse the response
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          const jsonString = text.substring(jsonStart, jsonEnd + 1);
          JSON.parse(jsonString);
          workingModel = modelName;
          break;
        }
      } catch (error) {
        lastError = error;
        console.log(`Model ${modelName} test failed:`, error.message);
      }
    }

    if (workingModel) {
      return { success: true, model: workingModel };
    } else {
      throw lastError || new Error("No models available");
    }
  } catch (error) {
    console.error("Gemini API test failed:", error);
    return { success: false, error: error.message };
  }
}

// Helper function to calculate next recurring date
function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  switch (interval) {
    case "DAILY":
      date.setDate(date.getDate() + 1);
      break;
    case "WEEKLY":
      date.setDate(date.getDate() + 7);
      break;
    case "MONTHLY":
      date.setMonth(date.getMonth() + 1);
      break;
    case "YEARLY":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }

  return date;
}
