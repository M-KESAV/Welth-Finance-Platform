"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

export async function getCurrentBudget(accountId) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    let budget = null;
    try {
      budget = await db.budget.findFirst({
        where: {
          userId: user.id,
        },
      });
    } catch (error) {
      console.error("Error fetching budget from database:", error.message);
      // Continue with null budget
    }

    // Get current month's expenses
    let expenses = { _sum: { amount: null } };
    try {
      const currentDate = new Date();
      const startOfMonth = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        1
      );
      const endOfMonth = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth() + 1,
        0
      );

      expenses = await db.transaction.aggregate({
        where: {
          userId: user.id,
          type: "EXPENSE",
          date: {
            gte: startOfMonth,
            lte: endOfMonth,
          },
          accountId,
        },
        _sum: {
          amount: true,
        },
      });
    } catch (error) {
      console.error("Error fetching expenses from database:", error.message);
      // Continue with default expenses object
    }

    return {
      budget: budget ? { ...budget, amount: budget.amount.toNumber() } : null,
      currentExpenses: expenses._sum.amount
        ? expenses._sum.amount.toNumber()
        : 0,
    };
  } catch (error) {
    console.error("Error fetching budget:", error);
    // Return safe fallback values
    return {
      budget: null,
      currentExpenses: 0,
    };
  }
}

export async function updateBudget(amount) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Update or create budget
    let budget;
    try {
      budget = await db.budget.upsert({
        where: {
          userId: user.id,
        },
        update: {
          amount,
        },
        create: {
          userId: user.id,
          amount,
        },
      });
    } catch (error) {
      console.error("Error updating budget in database:", error.message);
      throw new Error("Failed to update budget. Database connection issue.");
    }

    revalidatePath("/dashboard");
    return {
      success: true,
      data: { ...budget, amount: budget.amount.toNumber() },
    };
  } catch (error) {
    console.error("Error updating budget:", error);
    return { success: false, error: error.message };
  }
}