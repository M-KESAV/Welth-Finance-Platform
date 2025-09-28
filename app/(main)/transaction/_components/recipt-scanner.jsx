"use client";

import { useRef, useEffect } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import useFetch from "@/hooks/use-fetch";
import { scanReceipt } from "@/actions/transaction";

export function ReceiptScanner({ onScanComplete }) {
  const fileInputRef = useRef(null);

  const {
    loading: scanReceiptLoading,
    fn: scanReceiptFn,
    data: scannedData,
    error: scanError,
  } = useFetch(scanReceipt);

  const handleReceiptScan = async (file) => {
    if (file.size > 5 * 1024 * 1024) {
      toast.error("File size should be less than 5MB");
      return;
    }

    // Create FormData and append the file
    const formData = new FormData();
    formData.append('file', file);
    
    await scanReceiptFn(formData);
  };

  useEffect(() => {
    if (scanError && !scanReceiptLoading) {
      console.error("Receipt scan error:", scanError);
      toast.error("Failed to scan receipt. Please try again or manually enter details.");
    }
  }, [scanError, scanReceiptLoading]);

  useEffect(() => {
    if (scannedData && !scanReceiptLoading) {
      // Check if we have an error message
      if (scannedData.description && 
          (scannedData.description.includes("Error:") || 
           scannedData.description.includes("Failed to connect"))) {
        toast.error("AI service unavailable. Please manually enter receipt details.");
        // Still call onScanComplete so user can see the message in the form
        onScanComplete(scannedData);
      }
      // Check if we have meaningful data (not just defaults)
      else if (scannedData.amount > 0 || 
               (scannedData.description && 
                !scannedData.description.includes("Receipt scan") && 
                !scannedData.description.includes("format not recognized"))) {
        onScanComplete(scannedData);
        toast.success("Receipt scanned successfully!");
      } else if (scannedData.description && scannedData.description.includes("format not recognized")) {
        // AI worked but couldn't parse the response properly
        onScanComplete(scannedData);
        toast.info("Receipt scanned but format not recognized. Please manually enter details.");
      } else {
        // We got defaults or limited data
        onScanComplete(scannedData);
        toast.info("Receipt scanned. Please review and manually adjust details if needed.");
      }
    }
  }, [scanReceiptLoading, scannedData]);

  return (
    <div className="flex items-center gap-4">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            toast.info("Scanning receipt...");
            handleReceiptScan(file);
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        className="w-full h-10 bg-gradient-to-br from-orange-500 via-pink-500 to-purple-500 animate-gradient hover:opacity-90 transition-opacity text-white hover:text-white"
        onClick={() => fileInputRef.current?.click()}
        disabled={scanReceiptLoading}
      >
        {scanReceiptLoading ? (
          <>
            <Loader2 className="mr-2 animate-spin" />
            <span>Scanning Receipt...</span>
          </>
        ) : (
          <>
            <Camera className="mr-2" />
            <span>Scan Receipt with AI</span>
          </>
        )}
      </Button>
    </div>
  );
}