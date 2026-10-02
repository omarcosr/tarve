import { Questionnaire, type QuestionnaireAnswer } from "@tarve/core";

let current = 0;
let values: Record<string, QuestionnaireAnswer | undefined> = {};

<Questionnaire
  current={current}
  values={values}
  questions={[
    { id: "name", title: "What's your name?", type: "text", required: true },
    {
      id: "runtime",
      title: "Favourite runtime?",
      type: "single",
      options: [
        { value: "bun", label: "Bun" },
        { value: "node", label: "Node" },
      ],
    },
  ]}
  onCurrentChange={(index) => {
    current = index;
  }}
  onValueChange={(id, value) => {
    values = { ...values, [id]: value };
  }}
  onSubmit={() => console.log(values)}
/>;
