# Container-image Lambda: deploys to AWS Lambda as is. docker-compose runs the same
# image with local-server.js as entrypoint (see that file for why).
FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm install
COPY index.ts local-server.ts ./
RUN npm run build

FROM public.ecr.aws/lambda/nodejs:22
COPY package*.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev
COPY --from=build /build/dist/*.js ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
