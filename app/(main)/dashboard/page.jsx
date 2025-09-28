import { Suspense } from "react";
import { getUserAccounts } from "@/actions/dashboard";
import { getDashboardData } from "@/actions/dashboard";
import { getCurrentBudget } from "@/actions/budget";
import { AccountCard } from "./_components/account-card";
import { CreateAccountDrawer } from "@/components/create-account-drawer";
import { BudgetProgress } from "./_components/budget-progress";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";
import { DashboardOverview } from "./_components/transaction-overview";

export default async function DashboardPage() {
  let accounts = [];
  let transactions = [];
  
  try {
    const results = await Promise.allSettled([
      getUserAccounts(),
      getDashboardData(),
    ]);
    
    accounts = results[0].status === 'fulfilled' ? results[0].value : [];
    transactions = results[1].status === 'fulfilled' ? results[1].value : [];
  } catch (error) {
    console.error("Error loading dashboard data:", error);
    // Continue with empty arrays
  }

  const defaultAccount = accounts?.find((account) => account?.isDefault);

  // Get budget for default account
  let budgetData = null;
  if (defaultAccount) {
    try {
      budgetData = await getCurrentBudget(defaultAccount.id);
    } catch (error) {
      console.error("Error loading budget data:", error);
      // Continue with null budgetData
    }
  }

  return (
    <div className="space-y-8">
      {/* Budget Progress */}
      <BudgetProgress
        initialBudget={budgetData?.budget}
        currentExpenses={budgetData?.currentExpenses || 0}
      />

      {/* Dashboard Overview */}
      <DashboardOverview
        accounts={accounts || []}
        transactions={transactions || []}
      />

      {/* Accounts Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <CreateAccountDrawer>
          <Card className="hover:shadow-md transition-shadow cursor-pointer border-dashed">
            <CardContent className="flex flex-col items-center justify-center text-muted-foreground h-full pt-5">
              <Plus className="h-10 w-10 mb-2" />
              <p className="text-sm font-medium">Add New Account</p>
            </CardContent>
          </Card>
        </CreateAccountDrawer>
        {accounts && accounts.length > 0 &&
          accounts.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
      </div>
      
      {/* Show message when no accounts exist */}
      {accounts && accounts.length === 0 && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">No accounts found. Create your first account to get started.</p>
        </div>
      )}
    </div>
  );
}