import {
  DEFAULT_LIBRARY_PREFERENCES,
  decodeLibraryPreferences,
} from "../../ui/library-preferences";
import { openDatabase, requestValue, transactionDone } from "./database";
import { DATABASE_NAME, STORES, type StoredLibraryPreferencesV1 } from "./schema";

const LIBRARY_KEY = "library";

export class UiPreferencesRepository {
  constructor(private readonly databaseName = DATABASE_NAME) {}

  async getLibraryPreferences(): Promise<StoredLibraryPreferencesV1> {
    const database = await openDatabase(this.databaseName);
    database.addEventListener("versionchange", () => database.close(), { once: true });
    try {
      const transaction = database.transaction(STORES.uiPreferences, "readonly");
      const value = await requestValue(
        transaction.objectStore(STORES.uiPreferences).get(LIBRARY_KEY),
      );
      await transactionDone(transaction);
      return value === undefined ? DEFAULT_LIBRARY_PREFERENCES : decodeLibraryPreferences(value);
    } finally {
      database.close();
    }
  }

  async replaceLibraryPreferences(value: StoredLibraryPreferencesV1): Promise<void> {
    const preferences = decodeLibraryPreferences(value);
    const database = await openDatabase(this.databaseName);
    database.addEventListener("versionchange", () => database.close(), { once: true });
    try {
      const transaction = database.transaction(STORES.uiPreferences, "readwrite");
      transaction.objectStore(STORES.uiPreferences).put(preferences, LIBRARY_KEY);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}
