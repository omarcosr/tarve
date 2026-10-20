import { Text, View } from "@pocketjs/framework/solid/components";
import { count, decrease, increase, protectClose, status, toggleProtect } from "./app";

export default function App() {
  return (
    <View debugName="Counter" class="w-full h-full flex-col items-center justify-center gap-5 p-8 bg-white">
      <Text class="text-sm text-slate-600">A native MicroTS application</Text>
      <Text class="text-4xl text-slate-950 font-bold">{count()}</Text>
      <View class="flex-row gap-3">
        <View
          debugName="Decrease"
          class="px-4 py-2 rounded-lg border border-slate-300 bg-white focus:bg-slate-100 active:bg-slate-200"
          focusable
          onPress={() => decrease()}
        >
          <Text class="text-sm text-slate-900">- Decrease</Text>
        </View>
        <View
          debugName="Increase"
          class="px-4 py-2 rounded-lg bg-slate-900 focus:bg-slate-700 active:bg-black"
          focusable
          onPress={() => increase()}
        >
          <Text class="text-sm text-white">Increase +</Text>
        </View>
      </View>
      <Text class="text-xs text-slate-500">{status()}</Text>
      <View
        debugName="Protect"
        class="px-3 py-1 rounded-md bg-red-600 focus:bg-red-500"
        focusable
        onPress={() => toggleProtect()}
      >
        <Text class="text-xs text-white">{protectClose() ? "Allow close" : "Protect close"}</Text>
      </View>
    </View>
  );
}
