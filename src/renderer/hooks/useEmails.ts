import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DashboardEmail } from "../../shared/types";
import { useAppStore } from "../store";

export function useEmails() {
  const _queryClient = useQueryClient();
  const {
    setEmails,
    setLoading: _setLoading,
    setError: _setError,
    updateEmail,
    currentAccountId,
  } = useAppStore();

  const fetchEmailsQuery = useQuery({
    queryKey: ["emails", currentAccountId],
    queryFn: async () => {
      const result = await window.api.gmail.fetchUnread(100, currentAccountId ?? undefined);
      if (result.success) {
        setEmails(result.data);
        return result.data;
      }
      throw new Error(result.error);
    },
    enabled: false,
  });

  const analyzeMutation = useMutation({
    mutationFn: async (emailId: string) => {
      const result = await window.api.analysis.analyze(emailId);
      if (result.success) {
        // TODO(typed-bridge): the sidecar's analysis.analyze returns
        // AnalysisResult ({ needs_reply, reason, priority }). The
        // onSuccess wiring below assumes a DashboardEmail row, which
        // never matched. This hook is unreferenced today; leaving the
        // stale shape with a TODO so the next sprint reshapes it.
        return { id: emailId, ...result.data } as unknown as DashboardEmail;
      }
      throw new Error(result.error);
    },
    onSuccess: (data) => {
      updateEmail(data.id, data);
    },
  });

  const analyzeBatchMutation = useMutation({
    mutationFn: async (emailIds: string[]) => {
      const result = await window.api.analysis.analyzeBatch(emailIds);
      if (result.success) {
        // TODO(typed-bridge): same shape mismatch as analyzeMutation
        // above — the batch result is `{ results: ... }`, not an Email
        // array. The setEmails(data) call below was always misshapen.
        return result.data as unknown as DashboardEmail[];
      }
      throw new Error(result.error);
    },
    onSuccess: (data) => {
      setEmails(data);
    },
  });

  const createDraftMutation = useMutation({
    mutationFn: async ({
      emailId,
      body,
      accountId,
    }: {
      emailId: string;
      body: string;
      accountId?: string;
    }) => {
      // TODO(typed-bridge): the shim's gmail.createDraft accepts a single
      // ComposeSendInput-shaped object, not 5 positional args. This call
      // site is dead today (the renderer drives draft creation via the
      // compose.* namespace) but kept type-safe via a cast until the
      // adjacent call sites are migrated.
      const result = await window.api.gmail.createDraft({
        emailId,
        body,
        accountId,
      });
      if (result.success) {
        return { emailId, draftId: result.data.draftId };
      }
      throw new Error(result.error);
    },
    onSuccess: ({ emailId, draftId }) => {
      const email = useAppStore.getState().emails.find((e) => e.id === emailId);
      if (email?.draft) {
        updateEmail(emailId, {
          draft: {
            ...email.draft,
            gmailDraftId: draftId,
            status: "created",
          },
        });
      }
    },
  });

  return {
    fetchEmails: fetchEmailsQuery.refetch,
    isFetchingEmails: fetchEmailsQuery.isFetching,
    analyze: analyzeMutation.mutate,
    isAnalyzing: analyzeMutation.isPending,
    analyzeBatch: analyzeBatchMutation.mutate,
    isAnalyzingBatch: analyzeBatchMutation.isPending,
    createDraft: createDraftMutation.mutate,
    isCreatingDraft: createDraftMutation.isPending,
  };
}
