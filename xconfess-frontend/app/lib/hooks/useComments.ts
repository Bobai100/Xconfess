"use client";

import { useMemo, useRef } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createComment,
  getComments,
  type CreateCommentParams,
  type GetCommentsResult,
} from "@/app/lib/api/comments";
import {
  restoreQuerySnapshots,
  snapshotConfessionQueries,
  updateConfessionQueries,
} from "@/app/lib/api/confessionCache";
import { queryKeys } from "@/app/lib/api/queryKeys";
import type { ApiError } from "@/app/lib/api/errors";
import type { Comment } from "@/app/lib/types/confession";

const DEFAULT_LIMIT = 10;
type CommentMutationError = Error & { apiError?: ApiError };

function ensureCommentPages(
  data: InfiniteData<GetCommentsResult> | undefined,
): InfiniteData<GetCommentsResult> {
  if (data) {
    return data;
  }

  return {
    pageParams: [1],
    pages: [{ comments: [], hasMore: false }],
  };
}

function upsertOptimisticComment(
  data: InfiniteData<GetCommentsResult> | undefined,
  optimisticComment: Comment,
): InfiniteData<GetCommentsResult> {
  const current = ensureCommentPages(data);
  const [firstPage, ...restPages] = current.pages;

  return {
    ...current,
    pages: [
      {
        ...firstPage,
        comments:
          optimisticComment.parentId == null
            ? [optimisticComment, ...firstPage.comments]
            : [...firstPage.comments, optimisticComment],
      },
      ...restPages,
    ],
  };
}

function replaceCommentById(
  data: InfiniteData<GetCommentsResult> | undefined,
  commentId: number,
  replacement: Comment,
): InfiniteData<GetCommentsResult> | undefined {
  if (!data) {
    return data;
  }

  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      comments: page.comments.map((comment) =>
        comment.id === commentId ? replacement : comment,
      ),
    })),
  };
}

function dedupeComments(comments: Comment[]): Comment[] {
  const seen = new Set<number>();

  return comments.filter((comment) => {
    if (seen.has(comment.id)) {
      return false;
    }

    seen.add(comment.id);
    return true;
  });
}

export function useCommentsQuery(confessionId: string, limit = DEFAULT_LIMIT) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.comments.byConfession(confessionId),
    queryFn: async ({ pageParam }) => {
      const result = await getComments(confessionId, {
        page: pageParam,
        limit,
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return result.data;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length + 1 : undefined,
    enabled: Boolean(confessionId),
  });

  const comments = useMemo(
    () =>
      dedupeComments(
        query.data?.pages.flatMap((page) => page.comments) ?? [],
      ),
    [query.data],
  );

  return {
    ...query,
    comments,
    hasMore: query.hasNextPage,
    loading: query.isLoading,
  };
}

export function useCreateCommentMutation(confessionId: string) {
  const queryClient = useQueryClient();
  const requestInFlightRef = useRef(false);

  return useMutation({
    mutationFn: async (variables: CreateCommentParams) => {
      const result = await createComment(confessionId, variables);

      if (!result.ok) {
        const error = new Error(result.error.message) as CommentMutationError;
        error.apiError = result.error;
        throw error;
      }

      return result.data;
    },
    onMutate: async (variables) => {
      if (requestInFlightRef.current) {
        throw new Error("A comment is already being submitted.");
      }
      requestInFlightRef.current = true;

      try {
        await queryClient.cancelQueries({
          queryKey: queryKeys.comments.byConfession(confessionId),
        });

        const previousComments = queryClient.getQueryData<
          InfiniteData<GetCommentsResult>
        >(queryKeys.comments.byConfession(confessionId));
        const previousConfessionQueries = snapshotConfessionQueries(queryClient);

        const optimisticComment: Comment = {
          id: -Date.now(),
          content: variables.content.trim(),
          createdAt: new Date().toISOString(),
          author: "You",
          confessionId,
          parentId: variables.parentId ?? null,
          replies: [],
          isOptimistic: true,
        };

        queryClient.setQueryData<InfiniteData<GetCommentsResult>>(
          queryKeys.comments.byConfession(confessionId),
          (current) => upsertOptimisticComment(current, optimisticComment),
        );

        updateConfessionQueries(queryClient, confessionId, (confession) => ({
          ...confession,
          commentCount: (confession.commentCount ?? 0) + 1,
        }));

        return {
          ownsInFlight: true,
          optimisticCommentId: optimisticComment.id,
          previousComments,
          previousConfessionQueries,
        };
      } catch (error) {
        requestInFlightRef.current = false;
        throw error;
      }
    },
    onError: async (error, _variables, context) => {
      queryClient.setQueryData(
        queryKeys.comments.byConfession(confessionId),
        context?.previousComments,
      );
      restoreQuerySnapshots(queryClient, context?.previousConfessionQueries);

      if ((error as CommentMutationError).apiError?.status === 409) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.comments.byConfession(confessionId),
            exact: true,
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.confessions.all,
          }),
        ]);
      }
    },
    onSuccess: (comment, _variables, context) => {
      queryClient.setQueryData<InfiniteData<GetCommentsResult>>(
        queryKeys.comments.byConfession(confessionId),
        (current) =>
          replaceCommentById(current, context?.optimisticCommentId ?? 0, comment),
      );

      queryClient.invalidateQueries({
        queryKey: queryKeys.comments.byConfession(confessionId),
        exact: true,
      });
    },
    onSettled: (_comment, _error, _variables, context) => {
      if (context?.ownsInFlight) {
        requestInFlightRef.current = false;
      }
    },
  });
}
