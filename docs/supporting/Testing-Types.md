🧱 1. The Core Functional Testing Pyramid

These tests validate that the software behavior matches the explicit business requirements and user stories. They are traditionally structured in a hierarchy from lowest to highest level: [1]
• Unit Testing: Verifies the smallest testable units of code, such as individual functions, hooks, or classes, completely isolated from external dependencies. [1]
• Integration Testing: Validates the communication, data transfer, and contracts between combined units, microservices, third-party APIs, or databases. [1]
• Component / API Testing: Focuses on testing endpoints (REST, GraphQL) directly, verifying request/response payloads, status codes, and edge data behaviors without a UI.
• End-to-End (E2E) UI Testing: Simulates a real user journey by testing the entire software stack from the front-end user interface all the way to the back-end database. [1]

⚡ 2. Non-Functional Testing (Performance & Security)

These types evaluate the operational characteristics, stability, and vulnerabilities of the application rather than specific user features. [1]

Performance & Scalability Testing

• Load Testing: Evaluates system behavior and response times under expected normal and peak user traffic volumes. [1]
• Stress Testing: Pushes the application past its structural breaking limits to observe how it handles resource exhaustion and how gracefully it recovers from failure. [1]
• Endurance (Soak) Testing: Runs a continuous load over an extended duration (e.g., 24–72 hours) to detect memory leaks, database connection exhaustion, or resource degradation.
• Spike Testing: Tests the system's reaction to a sudden, massive surge in traffic (e.g., a flash sale or breaking news event).

Security & Compliance

• Penetration Testing: Ethical hacking attempts targeting the application infrastructure to uncover security vulnerabilities, authentication flaws, or configuration gaps.
• Accessibility (a11y) Testing: Ensures the software is fully usable for individuals with disabilities, ensuring compliance with international benchmarks like the WCAG Guidelines.
• Compatibility Testing: Checks if the UI renders flawlessly across various browsers (Chrome, Safari, Firefox) and mobile operating systems (iOS, Android). [1]

🔄 3. Maintenance & Change-Related Testing

These testing types occur after modifications (bug fixes, refactors, or new features) have been introduced to the repository. [1]
• Smoke Testing (Build Verification): A rapid, high-level test suite executed on new builds to ensure the application boots up and core paths function before triggering deeper testing.
• Sanity Testing: A very targeted test pass focused strictly on verifying a narrow set of bug fixes or explicit component modifications.
• Regression Testing: Re-running established test suites to guarantee that recent code changes or feature updates have not broken or degraded existing, unchanged code paths. [1]

👁️ 4. Testing by Code Visibility Level

These methodologies categorize how deeply the QA engineer or automation tool interacts with the internal code logic. [1]
• Black-Box Testing: The tester has zero visibility into the internal code structures or logic, verifying functionality purely by feeding inputs and validating outputs.
• White-Box Testing: The tester has complete visibility into the source code, designing test vectors specifically to exercise internal paths, logic statements, loops, and conditions.
• Grey-Box Testing: A hybrid model where the tester has partial knowledge of the internals, such as direct database access or architectural schemas, while interacting primarily via external interfaces. [1]

👥 5. Release & User Validation Phase

• Alpha Testing: Internal validation performed by developers and QA engineers within the organization to identify critical defects before external exposure.
• Beta Testing: Releasing the stable pre-production software to a select group of real-world end-users to gather usability feedback and identify edge defects in diverse environments.
• User Acceptance Testing (UAT): The final verification process conducted by clients or business users to officially sign off that the software delivers the required business value and is ready for production deployment.
