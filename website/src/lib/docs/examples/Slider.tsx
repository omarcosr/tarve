import { Slider } from "@tarve/core";

let volume = 40;

<Slider
  label="Volume"
  value={volume}
  min={0}
  max={100}
  step={5}
  onValueChange={(value) => {
    volume = value;
  }}
/>;
