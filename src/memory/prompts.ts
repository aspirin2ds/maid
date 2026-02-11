import { z } from 'zod'

export const FactRetrievalSchema = z.object({
  facts: z
    .array(z.string())
    .describe('An array of distinct facts extracted from the conversation.'),
})

const MemoryUpdateItemSchema = z.object({
  id: z.string().describe('The unique identifier of the memory item.'),
  text: z.string().describe('The content of the memory item.'),
  event: z
    .enum(['ADD', 'UPDATE', 'DELETE', 'NONE'])
    .optional()
    .default('NONE')
    .describe('The action taken for this memory item (ADD, UPDATE, DELETE, or NONE).'),
  old_memory: z
    .string()
    .optional()
    .describe('The previous content of the memory item if the event was UPDATE.'),
})

export const MemoryUpdateSchema = z.object({
  memory: z
    .array(MemoryUpdateItemSchema)
    .describe('An array representing the state of memory items after processing new facts.'),
})

export type MemoryAction = z.infer<typeof MemoryUpdateItemSchema>

export function getFactRetrievalPrompt(conversationText: string): string {
  return `You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences. Your primary role is to extract relevant pieces of information from conversations and organize them into distinct, manageable facts.

Types of Information to Remember:

1. Store Personal Preferences: Keep track of likes, dislikes, and specific preferences in various categories such as food, products, activities, and entertainment.
2. Maintain Important Personal Details: Remember significant personal information like names, relationships, and important dates.
3. Track Plans and Intentions: Note upcoming events, trips, goals, and any plans the user has shared.
4. Remember Activity and Service Preferences: Recall preferences for dining, travel, hobbies, and other services.
5. Monitor Health and Wellness Preferences: Keep a record of dietary restrictions, fitness routines, and other wellness-related information.
6. Store Professional Details: Remember job titles, work habits, career goals, and other professional information.
7. Miscellaneous Information Management: Keep track of favorite books, movies, brands, and other miscellaneous details that the user shares.
8. Basic Facts and Statements: Store clear, factual statements that might be relevant for future context or reference.

Here are some few shot examples:

Input: Hi.
Output: {"facts" : []}

Input: The sky is blue and the grass is green.
Output: {"facts" : ["Sky is blue", "Grass is green"]}

Input: Hi, I am looking for a restaurant in San Francisco.
Output: {"facts" : ["Looking for a restaurant in San Francisco"]}

Input: Yesterday, I had a meeting with John at 3pm. We discussed the new project.
Output: {"facts" : ["Had a meeting with John at 3pm", "Discussed the new project"]}

Input: Hi, my name is John. I am a software engineer.
Output: {"facts" : ["Name is John", "Is a Software engineer"]}

Input: Me favourite movies are Inception and Interstellar.
Output: {"facts" : ["Favourite movies are Inception and Interstellar"]}

Return the extracted facts as plain text lines only.
Use this exact output format:
- One fact per line, prefixed with "FACT: "
- If nothing should be stored, output exactly one line: "NONE"

Remember the following:
- Today's date is ${new Date().toISOString().split('T')[0]}.
- Do not return anything from the custom few shot example prompts provided above.
- If you do not find anything relevant in the below conversation, return exactly: NONE
- Create the facts based on the user and assistant messages only. Do not pick anything from the system messages.
- You should detect the language of the user input and record the facts in the same language.
- For basic factual statements, break them down into individual facts if they contain multiple pieces of information.

Following is a conversation between the user and the assistant. You have to extract the relevant facts and preferences about the user, if any.

Input:
${conversationText}`
}

export function getUpdateMemoryPrompt(
  existingMemories: { id: string; text: string }[],
  newFacts: string[],
): string {
  return `You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) add into the memory, (2) update the memory, (3) delete from the memory, and (4) no change.

Based on the above four operations, the memory will change.

Compare newly retrieved facts with the existing memory. For each new fact, decide whether to:
- ADD: Add it to the memory as a new element
- UPDATE: Update an existing memory element
- DELETE: Delete an existing memory element
- NONE: Make no change (if the fact is already present or irrelevant)

There are specific guidelines to select which operation to perform:

1. **Add**: If the retrieved facts contain new information not present in the memory, then you have to add it by generating a new ID in the id field.
    - **Example**:
        - Old Memory:
            [
                {
                    "id" : "0",
                    "text" : "User is a software engineer"
                }
            ]
        - Retrieved facts: ["Name is John"]
        - New Memory:
            {
                "memory" : [
                    {
                        "id" : "0",
                        "text" : "User is a software engineer",
                        "event" : "NONE"
                    },
                    {
                        "id" : "1",
                        "text" : "Name is John",
                        "event" : "ADD"
                    }
                ]
            }

2. **Update**: If the retrieved facts contain information that is already present in the memory but the information is totally different, then you have to update it.
    If the retrieved fact contains information that conveys the same thing as the elements present in the memory, then you have to keep the fact which has the most information.
    Example (a) -- if the memory contains "User likes to play cricket" and the retrieved fact is "Loves to play cricket with friends", then update the memory with the retrieved facts.
    Example (b) -- if the memory contains "Likes cheese pizza" and the retrieved fact is "Loves cheese pizza", then you do not need to update it because they convey the same information.
    If the direction is to update the memory, then you have to update it.
    Please keep in mind while updating you have to keep the same ID.
    Please note to return the IDs in the output from the input IDs only and do not generate any new ID.
    - **Example**:
        - Old Memory:
            [
                {
                    "id" : "0",
                    "text" : "I really like cheese pizza"
                },
                {
                    "id" : "1",
                    "text" : "User is a software engineer"
                },
                {
                    "id" : "2",
                    "text" : "User likes to play cricket"
                }
            ]
        - Retrieved facts: ["Loves chicken pizza", "Loves to play cricket with friends"]
        - New Memory:
            {
            "memory" : [
                    {
                        "id" : "0",
                        "text" : "Loves cheese and chicken pizza",
                        "event" : "UPDATE",
                        "old_memory" : "I really like cheese pizza"
                    },
                    {
                        "id" : "1",
                        "text" : "User is a software engineer",
                        "event" : "NONE"
                    },
                    {
                        "id" : "2",
                        "text" : "Loves to play cricket with friends",
                        "event" : "UPDATE",
                        "old_memory" : "User likes to play cricket"
                    }
                ]
            }

3. **Delete**: If the retrieved facts contain information that contradicts the information present in the memory, then you have to delete it. Or if the direction is to delete the memory, then you have to delete it.
    Please note to return the IDs in the output from the input IDs only and do not generate any new ID.
    - **Example**:
        - Old Memory:
            [
                {
                    "id" : "0",
                    "text" : "Name is John"
                },
                {
                    "id" : "1",
                    "text" : "Loves cheese pizza"
                }
            ]
        - Retrieved facts: ["Dislikes cheese pizza"]
        - New Memory:
            {
            "memory" : [
                    {
                        "id" : "0",
                        "text" : "Name is John",
                        "event" : "NONE"
                    },
                    {
                        "id" : "1",
                        "text" : "Loves cheese pizza",
                        "event" : "DELETE"
                    }
            ]
            }

4. **No Change**: If the retrieved facts contain information that is already present in the memory, then you do not need to make any changes.
    - **Example**:
        - Old Memory:
            [
                {
                    "id" : "0",
                    "text" : "Name is John"
                },
                {
                    "id" : "1",
                    "text" : "Loves cheese pizza"
                }
            ]
        - Retrieved facts: ["Name is John"]
        - New Memory:
            {
            "memory" : [
                    {
                        "id" : "0",
                        "text" : "Name is John",
                        "event" : "NONE"
                    },
                    {
                        "id" : "1",
                        "text" : "Loves cheese pizza",
                        "event" : "NONE"
                    }
                ]
            }

Below is the current content of my memory which I have collected till now:

${JSON.stringify(existingMemories, null, 2)}

The new retrieved facts are mentioned below. You have to analyze the new retrieved facts and determine whether these facts should be added, updated, or deleted in the memory.

${JSON.stringify(newFacts, null, 2)}

Follow the instruction mentioned below:
- Do not return anything from the custom few shot example prompts provided above.
- If the current memory is empty, then you have to add the new retrieved facts to the memory.
- If there is an addition, generate a new key and add the new memory corresponding to it.
- If there is a deletion, the memory key-value pair should be removed from the memory.
- If there is an update, the ID key should remain the same and only the value needs to be updated.

You MUST respond with one action per line using this exact pipe-delimited format:
<EVENT>|<ID>|<TEXT>|<OLD_MEMORY>

Rules for line format:
- EVENT must be ADD, UPDATE, DELETE, or NONE.
- For ADD, ID can be a newly generated string and OLD_MEMORY should be left empty.
- For UPDATE, ID must be one of the provided existing IDs and OLD_MEMORY should contain the previous text.
- For DELETE, ID must be one of the provided existing IDs and TEXT can repeat current text.
- For NONE, ID must be one of the provided existing IDs and OLD_MEMORY should be left empty.
- If there are no actions to take, output one NONE line for each existing memory item.
- Do not include extra separators. If text contains '|', replace it with '/'.

Examples:
ADD|new-1|Name is John|
UPDATE|0|Loves to play cricket with friends|User likes to play cricket
DELETE|1|Loves cheese pizza|
NONE|2|User is a software engineer|`
}
