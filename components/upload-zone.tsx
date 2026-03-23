import { useRouter } from "next/router";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { useTeam } from "@/context/team-context";
import { DocumentStorageType } from "@prisma/client";
import { useSession } from "next-auth/react";
import { DropEvent, FileRejection, useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { mutate } from "swr";

import { useAnalytics } from "@/lib/analytics";
import {
  FREE_PLAN_ACCEPTED_FILE_TYPES,
  FULL_PLAN_ACCEPTED_FILE_TYPES,
  SUPPORTED_DOCUMENT_MIME_TYPES,
} from "@/lib/constants";
import { DocumentData, createDocument } from "@/lib/documents/create-document";
import { resumableUpload } from "@/lib/files/tus-upload";
import {
  createFolderInBoth,
  createFolderInMainDocs,
  determineFolderPaths,
  isSystemFile,
} from "@/lib/folders/create-folder";
import { usePlan } from "@/lib/swr/use-billing";
import useLimits from "@/lib/swr/use-limits";
import { useTeamSettings } from "@/lib/swr/use-team-settings";
import { CustomUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getSupportedContentType } from "@/lib/utils/get-content-type";
import {
  getFileSizeLimit,
  getFileSizeLimits,
} from "@/lib/utils/get-file-size-limits";
import { getPagesCount } from "@/lib/utils/get-page-number-count";

// Originally these mime values were directly used in the dropzone hook.
// There was a solid reason to take them out of the scope, primarily to solve a browser compatibility issue to determine the file type when user dropped a folder.
// you will figure out how this change helped to fix the compatibility issue once you have went through reading of `getFilesFromDropEvent` and `traverseFolder`
const acceptableDropZoneMimeTypesWhenIsFreePlanAndNotTrial =
  FREE_PLAN_ACCEPTED_FILE_TYPES;
const allAcceptableDropZoneMimeTypes = FULL_PLAN_ACCEPTED_FILE_TYPES;

interface FileWithPaths extends File {
  path?: string;
  whereToUploadPath?: string;
  dataroomUploadPath?: string;
}

type FolderPathMapping = {
  uploadPath?: string;
  dataroomPath?: string;
};

type ValidationFailure = {
  fileName: string;
  message: string;
};

export interface UploadState {
  fileName: string;
  progress: number;
  documentId?: string;
  uploadId: string;
}

export interface RejectedFile {
  fileName: string;
  message: string;
}

interface UploadZoneProps extends React.PropsWithChildren {
  onUploadStart: (uploads: UploadState[]) => void;
  onUploadProgress: (
    index: number,
    progress: number,
    documentId?: string,
  ) => void;
  onUploadRejected: (rejected: RejectedFile[]) => void;
  onUploadSuccess?: (
    files: {
      fileName: string;
      documentId: string;
      dataroomDocumentId: string;
    }[],
  ) => void;
  setUploads: React.Dispatch<React.SetStateAction<UploadState[]>>;
  setRejectedFiles: React.Dispatch<React.SetStateAction<RejectedFile[]>>;
  folderPathName?: string;
  dataroomId?: string;
  dataroomName?: string;
}

export default function UploadZone({
  children,
  onUploadStart,
  onUploadProgress,
  onUploadRejected,
  onUploadSuccess,
  folderPathName,
  setUploads,
  setRejectedFiles,
  dataroomId,
  dataroomName,
}: UploadZoneProps) {
  const analytics = useAnalytics();
  const { plan, isFree, isTrial } = usePlan();
  const router = useRouter();
  const teamInfo = useTeam();
  const { data: session } = useSession();
  const { limits, isPaused } = useLimits();
  const hasDocumentLimit = limits?.documents != null && limits.documents > 0;
  const remainingDocuments = hasDocumentLimit
    ? limits.documents - (limits?.usage?.documents ?? 0)
    : Infinity;

  // Fetch team settings with proper revalidation - ensures settings stay fresh across tabs
  const { settings: teamSettings } = useTeamSettings(teamInfo?.currentTeam?.id);
  const replicateDataroomFolders =
    teamSettings?.replicateDataroomFolders ?? true;

  // Track if we've created the dataroom folder in "All Documents" for non-replication mode
  // Using promise-lock pattern to prevent race conditions during concurrent folder creation
  const dataroomFolderPathRef = useRef<string | null>(null);
  const dataroomFolderCreationPromiseRef = useRef<Promise<string> | null>(null);
  const fileLimitTruncatedRef = useRef(false);

  // Reset the cached dataroom folder path when the replication setting changes
  // This ensures we don't use stale cached paths if the setting is toggled
  useEffect(() => {
    dataroomFolderPathRef.current = null;
    dataroomFolderCreationPromiseRef.current = null;
  }, [replicateDataroomFolders, dataroomId]);

  const fileSizeLimits = useMemo(
    () =>
      getFileSizeLimits({
        limits,
        isFree,
        isTrial,
      }),
    [limits, isFree, isTrial],
  );

  const acceptableDropZoneFileTypes =
    isFree && !isTrial
      ? acceptableDropZoneMimeTypesWhenIsFreePlanAndNotTrial
      : allAcceptableDropZoneMimeTypes;

  const acceptedMimeToExtensions = useMemo(
    () =>
      Object.entries(acceptableDropZoneFileTypes).reduce<
        Record<string, string[]>
      >((acc, [mimeType, extensions]) => {
        acc[mimeType] = (extensions as string[]).map((extension) =>
          extension.toLowerCase(),
        );
        return acc;
      }, {}),
    [acceptableDropZoneFileTypes],
  );

  const acceptedExtensions = useMemo(
    () =>
      new Set(
        Object.values(acceptedMimeToExtensions).flatMap((extensions) =>
          extensions.map((extension) => extension.toLowerCase()),
        ),
      ),
    [acceptedMimeToExtensions],
  );

  const getFileExtension = useCallback((fileName: string) => {
    const fileExtension = fileName.split(".").pop()?.trim().toLowerCase();
    return fileExtension ? `.${fileExtension}` : "";
  }, []);

  const inferMimeTypeFromFileName = useCallback(
    (fileName: string) => {
      const extension = getFileExtension(fileName);
      if (!extension) {
        return undefined;
      }

      for (const [mimeType, extensions] of Object.entries(
        acceptedMimeToExtensions,
      )) {
        if (extensions.length === 0) {
          continue;
        }

        if (extensions.includes(extension)) {
          return mimeType;
        }
      }

      switch (extension) {
        case ".pdf":
          return "application/pdf";
        case ".xls":
          return "application/vnd.ms-excel";
        case ".xlsx":
          return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case ".csv":
          return "text/csv";
        case ".ods":
          return "application/vnd.oasis.opendocument.spreadsheet";
        case ".png":
          return "image/png";
        case ".jpeg":
        case ".jpg":
          return "image/jpeg";
        case ".ppt":
          return "application/vnd.ms-powerpoint";
        case ".pptx":
          return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        case ".odp":
          return "application/vnd.oasis.opendocument.presentation";
        case ".key":
          return "application/vnd.apple.keynote";
        case ".doc":
          return "application/msword";
        case ".docx":
          return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case ".odt":
          return "application/vnd.oasis.opendocument.text";
        case ".rtf":
          return "application/rtf";
        case ".txt":
          return "text/plain";
        case ".dwg":
          return "image/vnd.dwg";
        case ".dxf":
          return "image/vnd.dxf";
        case ".zip":
          return "application/zip";
        case ".mp4":
          return "video/mp4";
        case ".mov":
          return "video/quicktime";
        case ".avi":
          return "video/x-msvideo";
        case ".webm":
          return "video/webm";
        case ".ogg":
          return "video/ogg";
        case ".m4a":
          return "audio/mp4";
        case ".mp3":
          return "audio/mpeg";
        case ".kml":
          return "application/vnd.google-earth.kml+xml";
        case ".kmz":
          return "application/vnd.google-earth.kmz";
        case ".msg":
          return "application/vnd.ms-outlook";
        default:
          return undefined;
      }
    },
    [acceptedMimeToExtensions, getFileExtension],
  );

  const normalizeDroppedFile = useCallback(
    (file: FileWithPaths) => {
      if (file.type) {
        return file;
      }

      const inferredMimeType = inferMimeTypeFromFileName(file.name);
      if (!inferredMimeType) {
        return file;
      }

      const normalizedFile = new File([file], file.name, {
        type: inferredMimeType,
        lastModified: file.lastModified,
      }) as FileWithPaths;

      normalizedFile.path = file.path;
      normalizedFile.whereToUploadPath = file.whereToUploadPath;
      normalizedFile.dataroomUploadPath = file.dataroomUploadPath;

      return normalizedFile;
    },
    [inferMimeTypeFromFileName],
  );

  const isAcceptedDroppedFile = useCallback(
    (file: FileWithPaths) => {
      if (
        file.type &&
        Object.prototype.hasOwnProperty.call(acceptableDropZoneFileTypes, file.type)
      ) {
        return true;
      }

      const extension = getFileExtension(file.name);
      if (!extension) {
        return false;
      }

      return acceptedExtensions.has(extension);
    },
    [acceptableDropZoneFileTypes, acceptedExtensions, getFileExtension],
  );

  const readAllDirectoryEntries = useCallback(
    async (directoryEntry: FileSystemDirectoryEntry) => {
      const directoryReader = directoryEntry.createReader();
      const allEntries: FileSystemEntry[] = [];

      while (true) {
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          directoryReader.readEntries(resolve, reject),
        );

        if (entries.length === 0) {
          break;
        }

        allEntries.push(...entries);
      }

      return allEntries;
    },
    [],
  );

  const countsTowardDocumentLimit = useCallback(
    (file: FileWithPaths) => {
      if (!isAcceptedDroppedFile(file)) {
        return false;
      }

      const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
      return file.size <= fileSizeLimitMB * 1024 * 1024;
    },
    [fileSizeLimits, isAcceptedDroppedFile],
  );

  // Helper function to get or create the dataroom folder in "All Documents"
  // Uses promise-lock pattern to prevent concurrent creation attempts
  const getOrCreateDataroomFolder = useCallback(async (): Promise<string> => {
    // If we already have the path cached, return it immediately
    if (dataroomFolderPathRef.current) {
      return dataroomFolderPathRef.current;
    }

    // If there's an ongoing creation, await it
    if (dataroomFolderCreationPromiseRef.current) {
      return dataroomFolderCreationPromiseRef.current;
    }

    // Start a new creation process
    const creationPromise = (async () => {
      try {
        if (!teamInfo?.currentTeam?.id || !dataroomName) {
          throw new Error("Missing team ID or dataroom name");
        }

        // First check if the folder already exists
        const existingFoldersResponse = await fetch(
          `/api/teams/${teamInfo.currentTeam.id}/folders?root=true`,
        );

        if (existingFoldersResponse.ok) {
          const existingFolders = await existingFoldersResponse.json();
          const existingDataroomFolder = existingFolders.find(
            (folder: any) => folder.name === dataroomName,
          );

          if (existingDataroomFolder) {
            // Folder already exists, use it
            const folderPath = existingDataroomFolder.path.startsWith("/")
              ? existingDataroomFolder.path.slice(1)
              : existingDataroomFolder.path;
            dataroomFolderPathRef.current = folderPath;
            return folderPath;
          }
        }

        // Folder doesn't exist, create it
        const dataroomFolderResponse = await createFolderInMainDocs({
          teamId: teamInfo.currentTeam.id,
          name: dataroomName,
          path: undefined, // Create at root level
        });

        const folderPath = dataroomFolderResponse.path.startsWith("/")
          ? dataroomFolderResponse.path.slice(1)
          : dataroomFolderResponse.path;

        dataroomFolderPathRef.current = folderPath;

        analytics.capture("Dataroom Folder Created in Main Docs", {
          folderName: dataroomName,
          dataroomId,
        });

        return folderPath;
      } catch (error) {
        console.error("Error handling dataroom folder:", error);
        // Clear the promise ref on error so subsequent attempts can retry
        dataroomFolderCreationPromiseRef.current = null;
        // Use dataroom name as fallback path
        const fallbackPath = dataroomName || "";
        dataroomFolderPathRef.current = fallbackPath;
        return fallbackPath;
      } finally {
        // Clear the promise ref once creation is complete
        dataroomFolderCreationPromiseRef.current = null;
      }
    })();

    // Store the promise so concurrent callers can await it
    dataroomFolderCreationPromiseRef.current = creationPromise;
    return creationPromise;
  }, [teamInfo, dataroomName, dataroomId, analytics]);

  const assignUploadPathsToFiles = useCallback(
    async (files: FileWithPaths[]): Promise<FileWithPaths[]> => {
      const normalizePath = (path: string) =>
        path.startsWith("/") ? path.slice(1) : path;
      const folderPathPromises = new Map<string, Promise<FolderPathMapping>>();
      const preparedFiles: FileWithPaths[] = [];

      const ensureFolderPath = async (
        relativeFolderPath: string,
      ): Promise<FolderPathMapping> => {
        const existingPromise = folderPathPromises.get(relativeFolderPath);
        if (existingPromise) {
          return existingPromise;
        }

        const creationPromise = (async () => {
          const pathSegments = relativeFolderPath.split("/").filter(Boolean);
          const folderName = pathSegments.at(-1);

          if (!folderName || folderName.trim() === "") {
            setRejectedFiles((prev) => [
              {
                fileName: relativeFolderPath,
                message: "Folder name cannot be empty",
              },
              ...prev,
            ]);
            throw new Error("Folder name cannot be empty");
          }

          if (!teamInfo?.currentTeam?.id) {
            setRejectedFiles((prev) => [
              {
                fileName: "Unknown Team",
                message: "Team Id not found",
              },
              ...prev,
            ]);
            throw new Error("No team found");
          }

          const parentRelativePath = pathSegments.slice(0, -1).join("/");
          const parentMapping = parentRelativePath
            ? await ensureFolderPath(parentRelativePath)
            : undefined;

          if (!dataroomId) {
            const { path } = await createFolderInMainDocs({
              teamId: teamInfo.currentTeam.id,
              name: folderName,
              path: parentMapping?.uploadPath ?? folderPathName,
            });

            analytics.capture("Folder Added", { folderName });

            return {
              uploadPath: normalizePath(path),
              dataroomPath: undefined,
            };
          }

          const isFirstLevelFolder = parentRelativePath.length === 0;
          const {
            parentDataroomPath: targetParentDataroomPath,
            parentMainDocsPath: targetParentMainDocsPath,
          } = determineFolderPaths({
            currentDataroomPath: parentMapping?.dataroomPath ?? folderPathName,
            currentMainDocsPath: parentMapping?.uploadPath,
            isFirstLevelFolder,
          });

          if (!replicateDataroomFolders && dataroomName) {
            await getOrCreateDataroomFolder();
          }

          const { dataroomPath, mainDocsPath } = await createFolderInBoth({
            teamId: teamInfo.currentTeam.id,
            dataroomId,
            name: folderName,
            parentMainDocsPath: targetParentMainDocsPath,
            parentDataroomPath: targetParentDataroomPath,
            setRejectedFiles,
            analytics,
            replicateDataroomFolders,
          });

          return {
            uploadPath: mainDocsPath ? normalizePath(mainDocsPath) : undefined,
            dataroomPath: normalizePath(dataroomPath),
          };
        })();

        folderPathPromises.set(relativeFolderPath, creationPromise);
        return creationPromise;
      };

      for (const file of files) {
        try {
          const relativeDirectoryPath =
            file.path && file.path.includes("/")
              ? file.path.substring(0, file.path.lastIndexOf("/"))
              : "";
          const folderMapping = relativeDirectoryPath
            ? await ensureFolderPath(relativeDirectoryPath)
            : undefined;

          if (!replicateDataroomFolders && dataroomId && dataroomName) {
            file.whereToUploadPath = await getOrCreateDataroomFolder();
          } else {
            file.whereToUploadPath = folderMapping?.uploadPath ?? folderPathName;
          }

          file.dataroomUploadPath = dataroomId
            ? folderMapping?.dataroomPath ?? folderPathName
            : folderPathName;
          preparedFiles.push(file);
        } catch (error) {
          console.error("Failed to prepare upload folder paths:", error);
          setRejectedFiles((prev) => [
            {
              fileName: file.name,
              message: "Failed to prepare the destination folder",
            },
            ...prev,
          ]);
        }
      }

      return preparedFiles;
    },
    [
      analytics,
      dataroomId,
      dataroomName,
      folderPathName,
      getOrCreateDataroomFolder,
      replicateDataroomFolders,
      setRejectedFiles,
      teamInfo,
    ],
  );

  // this var will help to determine the correct api endpoint to request folder creation (If needed).
  const endpointTargetType = dataroomId
    ? `datarooms/${dataroomId}/folders`
    : "folders";

  const onDropRejected = useCallback(
    (rejectedFiles: FileRejection[]) => {
      const hasTooManyFiles = rejectedFiles.some(({ errors }) =>
        errors.some(({ code }) => code === "too-many-files"),
      );

      if (hasTooManyFiles) {
        const maxFiles = fileSizeLimits.maxFiles ?? 150;
        toast.error(
          `You're trying to upload ${rejectedFiles.length} files, but you can only upload up to ${maxFiles} files at once. Please upload in smaller batches.`,
          { duration: 8000 },
        );
        onUploadRejected([
          {
            fileName: `${rejectedFiles.length} files selected`,
            message: `Maximum ${maxFiles} files per upload`,
          },
        ]);
        return;
      }

      const rejected = rejectedFiles.map(({ file, errors }) => {
        let message = "";
        if (errors.find(({ code }) => code === "file-too-large")) {
          const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
          message = `File size too big (max. ${fileSizeLimitMB} MB). Upgrade to a paid plan to increase the limit.`;
        } else if (errors.find(({ code }) => code === "file-invalid-type")) {
          const isSupported = SUPPORTED_DOCUMENT_MIME_TYPES.includes(file.type);
          const fileExtension = getFileExtension(file.name);
          message = file.type
            ? `File type not supported ${
                isFree && !isTrial && isSupported ? `on free plan` : ""
              }`
            : fileExtension
              ? `.${fileExtension.slice(1)} files are not supported for this upload`
              : "This dropped file could not be identified";
        }
        return { fileName: file.name, message };
      });
      onUploadRejected(rejected);
    },
    [onUploadRejected, fileSizeLimits, isFree, isTrial, getFileExtension],
  );

  const onDrop = useCallback(
    async (acceptedFiles: FileWithPaths[]) => {
      // Check if team is paused
      if (isPaused) {
        toast.error(
          "Your subscription is paused. Resume your subscription to upload documents.",
          {
            action: {
              label: "Go to Billing",
              onClick: () => router.push("/settings/billing"),
            },
          },
        );
        return;
      }

      if (hasDocumentLimit && remainingDocuments <= 0) {
        toast.error(
          `You've reached your plan's document limit (${limits?.usage?.documents}/${limits?.documents} documents). Upgrade your plan to upload more.`,
          {
            action: {
              label: "Upgrade",
              onClick: () => router.push("/settings/billing"),
            },
            duration: 8000,
          },
        );
        return;
      }

      let filesToUpload = acceptedFiles.map(normalizeDroppedFile);

      if (fileLimitTruncatedRef.current) {
        // Folder traversal was already capped at remainingDocuments –
        // no extra folders were created, just show the warning.
        fileLimitTruncatedRef.current = false;
        toast.warning(
          `Your upload was limited to ${acceptedFiles.length} file${acceptedFiles.length === 1 ? "" : "s"} because your plan only allows ${remainingDocuments} more document${remainingDocuments === 1 ? "" : "s"} (${limits?.usage?.documents}/${limits?.documents} used).`,
          {
            action: {
              label: "Upgrade",
              onClick: () => router.push("/settings/billing"),
            },
            duration: 10000,
          },
        );
      } else if (hasDocumentLimit && acceptedFiles.length > remainingDocuments) {
        // Safety net for the file-picker path (no folder traversal) or
        // race conditions where the cap was slightly exceeded.
        const skippedCount = acceptedFiles.length - remainingDocuments;
        toast.warning(
          `You're trying to upload ${acceptedFiles.length} files, but your plan only allows ${remainingDocuments} more document${remainingDocuments === 1 ? "" : "s"} (${limits?.usage?.documents}/${limits?.documents} used). ${skippedCount} file${skippedCount === 1 ? "" : "s"} will be skipped.`,
          {
            action: {
              label: "Upgrade",
              onClick: () => router.push("/settings/billing"),
            },
            duration: 10000,
          },
        );
        filesToUpload = filesToUpload.slice(0, remainingDocuments);
      }

      const invalidTypeFiles = filesToUpload
        .filter((file) => !isAcceptedDroppedFile(file))
        .map<ValidationFailure>((file) => {
          const fileExtension = getFileExtension(file.name);
          const isSupported = file.type
            ? SUPPORTED_DOCUMENT_MIME_TYPES.includes(file.type)
            : false;

          return {
            fileName: file.name,
            message: file.type
              ? `File type not supported ${
                  isFree && !isTrial && isSupported ? `on free plan` : ""
                }`
              : fileExtension
                ? `Unsupported file extension ${fileExtension}`
                : "This dropped file could not be identified",
          };
        });

      if (invalidTypeFiles.length > 0) {
        setRejectedFiles((prev) => [...invalidTypeFiles, ...prev]);
        filesToUpload = filesToUpload.filter((file) => isAcceptedDroppedFile(file));

        if (filesToUpload.length === 0) {
          toast.error(
            `${invalidTypeFiles.length} file(s) could not be uploaded from the dropped folder`,
          );
          return;
        }

        toast.warning(
          `${invalidTypeFiles.length} file${invalidTypeFiles.length === 1 ? "" : "s"} in the dropped folder were skipped because they are not supported.`,
          { duration: 8000 },
        );
      }

      // Validate files and separate into valid and invalid
      const validatedFiles = filesToUpload.reduce<{
        valid: FileWithPaths[];
        invalid: { fileName: string; message: string }[];
      }>(
        (acc, file) => {
          const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
          const fileSizeLimit = fileSizeLimitMB * 1024 * 1024; // Convert to bytes

          if (file.size > fileSizeLimit) {
            acc.invalid.push({
              fileName: file.name,
              message: `File size too big (max. ${fileSizeLimitMB} MB)${
                isFree && !isTrial
                  ? ". Upgrade to a paid plan to increase the limit"
                  : ""
              }`,
            });
          } else {
            acc.valid.push(file);
          }
          return acc;
        },
        { valid: [], invalid: [] },
      );

      // Handle rejected files first
      if (validatedFiles.invalid.length > 0) {
        setRejectedFiles((prev) => [...validatedFiles.invalid, ...prev]);

        // If all files were rejected, show a summary toast
        if (validatedFiles.valid.length === 0) {
          toast.error(
            `${validatedFiles.invalid.length} file(s) exceeded size limits`,
          );
          return;
        }
      }

      const uploadReadyFiles = await assignUploadPathsToFiles(validatedFiles.valid);

      if (uploadReadyFiles.length === 0) {
        toast.error("No files from the dropped folder were ready to upload.");
        return;
      }

      // Continue with valid files
      const newUploads = uploadReadyFiles.map((file) => ({
        fileName: file.name,
        progress: 0,
        uploadId: crypto.randomUUID(),
      }));

      onUploadStart(newUploads);

      const uploadPromises = uploadReadyFiles.map(async (file, index) => {
        // Due to `getFilesFromEvent` file.path will always hold a valid value and represents the value of webkitRelativePath.
        // We no longer need to use webkitRelativePath because everything is been handled in `getFilesFromEvent`
        const path = file.path || file.name;

        // count the number of pages in the file
        let numPages = 1;
        if (file.type === "application/pdf") {
          const buffer = await file.arrayBuffer();
          numPages = await getPagesCount(buffer);

          if (numPages > fileSizeLimits.maxPages) {
            setUploads((prev) =>
              prev.filter((upload) => upload.fileName !== file.name),
            );

            return setRejectedFiles((prev) => [
              {
                fileName: file.name,
                message: `File has too many pages (max. ${fileSizeLimits.maxPages})`,
              },
              ...prev,
            ]);
          }
        }

        const { complete } = await resumableUpload({
          file, // File
          onProgress: (bytesUploaded, bytesTotal) => {
            const progress = Math.min(
              Math.round((bytesUploaded / bytesTotal) * 100),
              99,
            );
            setUploads((prevUploads) => {
              const updatedUploads = prevUploads.map((upload) =>
                upload.uploadId === newUploads[index].uploadId
                  ? { ...upload, progress }
                  : upload,
              );
              const currentUpload = updatedUploads.find(
                (upload) => upload.uploadId === newUploads[index].uploadId,
              );

              onUploadProgress(index, progress, currentUpload?.documentId);
              return updatedUploads;
            });
          },
          onError: (error) => {
            setUploads((prev) =>
              prev.filter(
                (upload) => upload.uploadId !== newUploads[index].uploadId,
              ),
            );

            setRejectedFiles((prev) => [
              { fileName: file.name, message: "Error uploading file" },
              ...prev,
            ]);
          },
          ownerId: (session?.user as CustomUser).id,
          teamId: teamInfo?.currentTeam?.id as string,
          numPages,
          relativePath: path.substring(0, path.lastIndexOf("/")),
        });

        const uploadResult = await complete;

        let contentType = uploadResult.fileType;
        let supportedFileType = getSupportedContentType(contentType) ?? "";

        if (
          uploadResult.fileName.endsWith(".dwg") ||
          uploadResult.fileName.endsWith(".dxf")
        ) {
          supportedFileType = "cad";
          contentType = `image/vnd.${uploadResult.fileName.split(".").pop()}`;
        }

        if (uploadResult.fileName.endsWith(".xlsm")) {
          supportedFileType = "sheet";
          contentType = "application/vnd.ms-excel.sheet.macroEnabled.12";
        }

        if (
          uploadResult.fileName.endsWith(".kml") ||
          uploadResult.fileName.endsWith(".kmz")
        ) {
          supportedFileType = "map";
          contentType = `application/vnd.google-earth.${uploadResult.fileName.endsWith(".kml") ? "kml+xml" : "kmz"}`;
        }

        const documentData: DocumentData = {
          key: uploadResult.id,
          supportedFileType: supportedFileType,
          name: file.name,
          storageType: DocumentStorageType.S3_PATH,
          contentType: contentType,
          fileSize: file.size,
        };

        const fileUploadPathName = file?.whereToUploadPath;
        const dataroomUploadPathName = file?.dataroomUploadPath;

        const response = await createDocument({
          documentData,
          teamId: teamInfo?.currentTeam?.id as string,
          numPages: uploadResult.numPages,
          folderPathName: fileUploadPathName,
        });

        // add the new document to the list
        mutate(`/api/teams/${teamInfo?.currentTeam?.id}/documents`);

        fileUploadPathName &&
          mutate(
            `/api/teams/${teamInfo?.currentTeam?.id}/folders/documents/${fileUploadPathName}`,
          );

        const document = await response.json();
        let dataroomResponse;
        if (dataroomId) {
          try {
            dataroomResponse = await fetch(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  documentId: document.id,
                  folderPathName: dataroomUploadPathName || fileUploadPathName,
                }),
              },
            );

            if (!dataroomResponse?.ok) {
              const { message } = await dataroomResponse.json();
              console.error(
                "An error occurred while adding document to the dataroom: ",
                message,
              );
              return;
            }

            mutate(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
            );
            (dataroomUploadPathName || fileUploadPathName) &&
              mutate(
                `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/folders/documents/${dataroomUploadPathName || fileUploadPathName}`,
              );
          } catch (error) {
            console.error(
              "An error occurred while adding document to the dataroom: ",
              error,
            );
          }
        }

        // update progress to 100%
        setUploads((prevUploads) =>
          prevUploads.map((upload) =>
            upload.uploadId === newUploads[index].uploadId
              ? { ...upload, progress: 100, documentId: document.id }
              : upload,
          ),
        );

        analytics.capture("Document Added", {
          documentId: document.id,
          name: document.name,
          numPages: document.numPages,
          path: router.asPath,
          type: document.type,
          contentType: document.contentType,
          teamId: teamInfo?.currentTeam?.id,
          bulkupload: true,
          dataroomId: dataroomId,
          $set: {
            teamId: teamInfo?.currentTeam?.id,
            teamPlan: plan,
          },
        });
        const dataroomDocumentId = dataroomResponse?.ok
          ? (await dataroomResponse.json()).id
          : null;

        return { ...document, dataroomDocumentId: dataroomDocumentId };
      });

      const documents = Promise.all(uploadPromises).finally(() => {
        /* If it a parentFolder was created prior to the upload, we would need to update that
           how many documents and folders does this folder contain rather than displaying 0
            */

        mutate(
          `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}?root=true`,
        );
        mutate(`/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}`);
        folderPathName &&
          mutate(
            `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}/${folderPathName}`,
          );
      });
      const uploadedDocuments = await documents;
      const dataroomDocuments = uploadedDocuments.map((document) => ({
        documentId: document.id,
        dataroomDocumentId: document.dataroomDocumentId,
        fileName: document.name,
      }));
      onUploadSuccess?.(dataroomDocuments);
    },
    [
      assignUploadPathsToFiles,
      analytics,
      dataroomId,
      endpointTargetType,
      fileSizeLimits,
      folderPathName,
      getFileExtension,
      hasDocumentLimit,
      isFree,
      isAcceptedDroppedFile,
      isPaused,
      isTrial,
      limits?.documents,
      limits?.usage?.documents,
      normalizeDroppedFile,
      onUploadProgress,
      onUploadStart,
      onUploadSuccess,
      plan,
      remainingDocuments,
      router,
      session?.user,
      setRejectedFiles,
      setUploads,
      teamInfo?.currentTeam?.id,
    ],
  );

  const getFilesFromEvent = useCallback(
    async (event: DropEvent) => {
      // This callback also run when event.type =`dragenter`. We only need to compute files when the event.type is `drop`.
      if ("type" in event && event.type !== "drop" && event.type !== "change") {
        return [];
      }

      fileLimitTruncatedRef.current = false;
      const fileLimit =
        hasDocumentLimit && isFinite(remainingDocuments)
          ? Math.max(0, remainingDocuments)
          : Infinity;
      let collectedFileCount = 0;

      // Early check: skip folder traversal (and folder creation) if document limit is already reached
      if (fileLimit <= 0) {
        return [];
      }

      let filesToBePassedToOnDrop: FileWithPaths[] = [];

      /** *********** START OF `traverseFolder` *********** */
      const traverseFolder = async (entry: FileSystemEntry): Promise<FileWithPaths[]> => {
        /**
         * Summary of this function:
         *  1. Reads dropped files and folders before any network requests.
         *  2. Smoothly handles the deeply nested folders.
         *  3. Preserves the full relative path so `onDrop` can create folders only for files that actually upload.
         */

        let files: FileWithPaths[] = [];

        if (isSystemFile(entry.name)) {
          return files;
        }

        if (collectedFileCount >= fileLimit) {
          return files;
        }

        if (entry.isDirectory) {
          try {
            const subEntries = await readAllDirectoryEntries(
              entry as FileSystemDirectoryEntry,
            );

            const filteredSubEntries = subEntries.filter(
              (subEntry) => !isSystemFile(subEntry.name),
            );

            for (const subEntry of filteredSubEntries) {
              files.push(...(await traverseFolder(subEntry)));
            }
          } catch (error) {
            console.error("An error occurred while reading the folder: ", error);
          }
        } else if (entry.isFile) {
          if (isSystemFile(entry.name)) {
            return files;
          }

          let file = await new Promise<FileWithPaths>((resolve) =>
            (entry as FileSystemFileEntry).file(resolve),
          );

          file = normalizeDroppedFile(file);

          // Reason of removing "/" because webkitRelativePath doesn't start with "/"
          file.path = entry.fullPath.startsWith("/")
            ? entry.fullPath.substring(1)
            : entry.fullPath;

          if (
            countsTowardDocumentLimit(file) &&
            collectedFileCount >= fileLimit
          ) {
            fileLimitTruncatedRef.current = true;
            return files;
          }

          files.push(file);
          if (countsTowardDocumentLimit(file)) {
            collectedFileCount++;
          }
        }

        return files;
      };
      /** *********** END OF `traverseFolder` *********** */

      if ("dataTransfer" in event && event.dataTransfer) {
        const items = event.dataTransfer.items;

        for (const item of Array.from(items)) {
          // MDN Note: This function is implemented as webkitGetAsEntry() in non-WebKit browsers including Firefox at this time; it may be renamed to getAsEntry() in the future, so you should code defensively, looking for both.
          const entry =
            (typeof item?.webkitGetAsEntry === "function" &&
              item.webkitGetAsEntry()) ??
            (typeof (item as any)?.getAsEntry === "function" &&
              (item as any).getAsEntry()) ??
            null;

          if (!entry) {
            continue;
          }

          filesToBePassedToOnDrop.push(...(await traverseFolder(entry)));
        }
      } else if (
        "target" in event &&
        event.target &&
        event.target instanceof HTMLInputElement &&
        event.target.files
      ) {
        for (let i = 0; i < event.target.files.length; i++) {
          const file = normalizeDroppedFile(
            event.target.files[i] as FileWithPaths,
          );
          file.path =
            (event.target.files[i] as FileWithPaths).webkitRelativePath ||
            file.name;

          if (
            countsTowardDocumentLimit(file) &&
            collectedFileCount >= fileLimit
          ) {
            fileLimitTruncatedRef.current = true;
            break;
          }

          if (countsTowardDocumentLimit(file)) {
            collectedFileCount++;
          }

          filesToBePassedToOnDrop.push(file);
        }
      }

      return filesToBePassedToOnDrop;
    },
    [
      countsTowardDocumentLimit,
      hasDocumentLimit,
      normalizeDroppedFile,
      readAllDirectoryEntries,
      remainingDocuments,
    ],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: acceptableDropZoneFileTypes,
    multiple: true,
    // maxSize: maxSize * 1024 * 1024, // 30 MB
    maxFiles: fileSizeLimits.maxFiles ?? 150,
    onDrop,
    onDropRejected,
    getFilesFromEvent,
  });

  return (
    <div
      {...getRootProps({ onClick: (evt) => evt.stopPropagation() })}
      className={cn(
        "relative",
        dataroomId ? "min-h-[calc(100vh-350px)]" : "min-h-[calc(100vh-270px)]",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 z-40 -m-1 rounded-lg border-2 border-dashed",
          isDragActive
            ? "pointer-events-auto border-primary/50 bg-gray-100/75 backdrop-blur-sm dark:bg-gray-800/75"
            : "pointer-events-none border-none",
        )}
      >
        <input
          {...getInputProps()}
          name="file"
          id="upload-multi-files-zone"
          className="sr-only"
        />

        {isDragActive && (
          <div className="sticky top-1/2 z-50 -translate-y-1/2 px-2">
            <div className="flex justify-center">
              <div className="inline-flex flex-col rounded-lg bg-background/95 px-6 py-4 text-center ring-1 ring-gray-900/5 dark:bg-gray-900/95 dark:ring-white/10">
                <span className="font-medium text-foreground">
                  Drop files or folders here
                </span>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {isFree && !isTrial
                    ? `Only *.pdf, *.xls, *.xlsx, *.csv, *.tsv, *.ods, *.png, *.jpeg, *.jpg`
                    : `Only *.pdf, *.pptx, *.docx, *.xlsx, *.xls, *.csv, *.tsv, *.ods, *.ppt, *.odp, *.doc, *.odt, *.dwg, *.dxf, *.png, *.jpg, *.jpeg, *.mp4, *.mov, *.avi, *.webm, *.ogg`}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {children}
    </div>
  );
}
