import 'dart:io';
import 'package:flutter/material.dart';

void main() => runApp(const BenchApp());

class BenchApp extends StatelessWidget {
  const BenchApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(debugShowCheckedModeBanner: false, home: const Bench());
}

class Bench extends StatefulWidget {
  const Bench({super.key});
  @override
  State<Bench> createState() => _BenchState();
}

class _BenchState extends State<Bench> {
  final bool list = Platform.environment['SCENE'] == 'list';
  int tick = 0;

  @override
  Widget build(BuildContext context) {
    final marker = tick == 0 ? const Color(0xffff00ff) : tick.isOdd ? const Color(0xff00ff00) : const Color(0xff0000ff);
    return Material(
      color: Colors.white,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(
          height: 48,
          child: Stack(children: [
            Positioned(left: 0, top: 0, width: 48, height: 48, child: ColoredBox(color: marker)),
            Positioned(left: 64, top: 8, width: 120, height: 32, child: ElevatedButton(onPressed: () => setState(() => tick++), child: const Text('Update'))),
          ]),
        ),
        if (list)
          Expanded(
            child: SingleChildScrollView(
              child: Column(children: [
                for (var i = 0; i < 2000; i++)
                  SizedBox(
                    height: 36,
                    child: Row(children: [
                      Expanded(child: Text('Record $i: native layout and text $tick')),
                      const SizedBox(width: 12),
                      TextButton(onPressed: () {}, child: const Text('Open')),
                    ]),
                  ),
              ]),
            ),
          )
        else
          const Text('hi'),
      ]),
    );
  }
}
