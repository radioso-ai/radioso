"use client";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { WizardShell } from "./wizard-shell.js";

interface WizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentSettingsHrefBuilder: (agentId: string) => string;
}

export function WizardDialog({ open, onOpenChange, agentSettingsHrefBuilder }: WizardDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[760px] gap-0 p-0 sm:max-w-[760px]">
        <DialogTitle className="sr-only">Create assistant from website</DialogTitle>
        <DialogDescription className="sr-only">
          Enter your website URL and we&apos;ll create a working assistant configured from your site content.
        </DialogDescription>
        <div className="max-h-[85vh] overflow-y-auto px-6 py-2">
          <WizardShell agentSettingsHrefBuilder={agentSettingsHrefBuilder} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default WizardDialog;
