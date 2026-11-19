import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

/**
 * MongoDB-backed Baileys auth state adapter.
 * Keeps WhatsApp Linked Device credentials intact across ephemeral container restarts
 * on free platforms like Render.com or Hugging Face Spaces.
 */
export async function useMongoAuthState(db, collectionName = 'wa_auth_state') {
  const collection = db.collection(collectionName);

  const writeData = async (key, data) => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await collection.updateOne(
      { _id: key },
      { $set: { value: serialized, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const readData = async (key) => {
    const doc = await collection.findOne({ _id: key });
    if (!doc || !doc.value) return null;
    return JSON.parse(doc.value, BufferJSON.reviver);
  };

  const removeData = async (key) => {
    await collection.deleteOne({ _id: key });
  };

  const clearAll = async () => {
    await collection.deleteMany({});
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    clearAll,
  };
}

